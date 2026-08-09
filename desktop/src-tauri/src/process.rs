use super::CommandResult;
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const TERMINATION_GRACE: Duration = Duration::from_secs(2);
const OUTPUT_LIMIT_BYTES: usize = 1_048_576;
const UTF8_LOOKAHEAD_BYTES: usize = 4;
const TRUNCATION_MARKER: &str = "\n[... output truncated ...]";

pub(crate) fn run_command(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, String)],
) -> Result<CommandResult, String> {
    run_command_with_policy(
        program,
        args,
        cwd,
        envs,
        COMMAND_TIMEOUT,
        TERMINATION_GRACE,
        OUTPUT_LIMIT_BYTES,
    )
}

fn run_command_with_policy(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, String)],
    timeout: Duration,
    termination_grace: Duration,
    output_limit: usize,
) -> Result<CommandResult, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Give the command and descendants their own group so timeout
        // escalation cannot leave a grandchild holding our pipes open.
        .process_group(0);
    if let Some(directory) = cwd {
        command.current_dir(directory);
    }
    for (key, value) in envs {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", program.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture child stderr".to_string())?;
    let retain_limit = output_limit.saturating_add(UTF8_LOOKAHEAD_BYTES);
    let stdout_reader = thread::spawn(move || drain_output(stdout, retain_limit));
    let stderr_reader = thread::spawn(move || drain_output(stderr, retain_limit));

    let initial_status = match child.wait_timeout(timeout) {
        Ok(status) => status,
        Err(error) => {
            let _ = terminate_process_group(&mut child, termination_grace);
            let _ = join_reader(stdout_reader, "stdout");
            let _ = join_reader(stderr_reader, "stderr");
            return Err(format!("failed while waiting for child process: {error}"));
        }
    };
    let timed_out = initial_status.is_none();
    let (status, escalated) = if let Some(status) = initial_status {
        (status, false)
    } else {
        terminate_process_group(&mut child, termination_grace)?
    };

    let stdout_capture = join_reader(stdout_reader, "stdout")?;
    let stderr_capture = join_reader(stderr_reader, "stderr")?;
    let stdout = render_capture(stdout_capture, output_limit, None);
    let timeout_diagnostic = timed_out.then(|| {
        if escalated {
            format!(
                "command timed out after {} seconds; SIGTERM grace expired after {} ms; escalated to SIGKILL",
                timeout.as_secs_f64(),
                termination_grace.as_millis(),
            )
        } else {
            format!(
                "command timed out after {} seconds; terminated with SIGTERM",
                timeout.as_secs_f64(),
            )
        }
    });
    let stderr = render_capture(stderr_capture, output_limit, timeout_diagnostic.as_deref());

    Ok(CommandResult {
        ok: status.success() && !timed_out,
        code: if timed_out {
            124
        } else {
            status.code().unwrap_or(1)
        },
        stdout,
        stderr,
    })
}

fn terminate_process_group(
    child: &mut Child,
    grace: Duration,
) -> Result<(ExitStatus, bool), String> {
    signal_process_group(child.id(), libc::SIGTERM);
    if let Some(status) = child
        .wait_timeout(grace)
        .map_err(|error| error.to_string())?
    {
        return Ok((status, false));
    }
    signal_process_group(child.id(), libc::SIGKILL);
    let status = child.wait().map_err(|error| error.to_string())?;
    Ok((status, true))
}

fn signal_process_group(pid: u32, signal: i32) {
    // SAFETY: kill does not dereference pointers. A negative pid addresses the
    // process group created with CommandExt::process_group above.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[derive(Debug)]
struct CapturedOutput {
    retained: Vec<u8>,
    total_bytes: usize,
}

fn drain_output<R: Read>(mut reader: R, retain_limit: usize) -> io::Result<CapturedOutput> {
    let mut retained = Vec::with_capacity(retain_limit);
    let mut total_bytes = 0usize;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(count);
        let available = retain_limit.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(available)]);
    }
    Ok(CapturedOutput {
        retained,
        total_bytes,
    })
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<CapturedOutput>>,
    stream: &str,
) -> Result<CapturedOutput, String> {
    reader
        .join()
        .map_err(|_| format!("{stream} reader thread panicked"))?
        .map_err(|error| format!("failed to drain child {stream}: {error}"))
}

fn render_capture(capture: CapturedOutput, limit: usize, diagnostic: Option<&str>) -> String {
    let decoded = String::from_utf8_lossy(&capture.retained);
    let combined = match diagnostic {
        Some(message) if decoded.is_empty() => message.to_string(),
        Some(message) => format!("{message}\n{decoded}"),
        None => decoded.into_owned(),
    };
    cap_utf8(
        &combined,
        limit,
        capture.total_bytes > capture.retained.len(),
    )
}

fn cap_utf8(value: &str, limit: usize, force_truncated: bool) -> String {
    if !force_truncated && value.len() <= limit {
        return value.to_string();
    }
    if limit == 0 {
        return String::new();
    }
    if limit <= TRUNCATION_MARKER.len() {
        return TRUNCATION_MARKER[..limit].to_string();
    }
    let budget = limit - TRUNCATION_MARKER.len();
    let mut boundary = budget.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}{}", &value[..boundary], TRUNCATION_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str, timeout: Duration, grace: Duration, limit: usize) -> CommandResult {
        run_command_with_policy(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            None,
            &[],
            timeout,
            grace,
            limit,
        )
        .expect("command should be supervised")
    }

    #[test]
    fn drains_large_stdout_and_stderr_without_deadlock() {
        let result = shell(
            "dd if=/dev/zero bs=262144 count=1 2>/dev/null; dd if=/dev/zero bs=262144 count=1 >&2 2>/dev/null",
            Duration::from_secs(2),
            Duration::from_millis(100),
            4096,
        );
        assert!(result.ok);
        assert!(result.stdout.len() <= 4096);
        assert!(result.stderr.len() <= 4096);
        assert!(result.stdout.ends_with(TRUNCATION_MARKER));
        assert!(result.stderr.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn truncates_valid_utf8_only_at_character_boundaries() {
        let result = shell(
            "printf 'seed-🌱🌱🌱🌱🌱🌱🌱🌱🌱🌱'",
            Duration::from_secs(1),
            Duration::from_millis(100),
            40,
        );
        assert!(result.ok);
        assert!(result.stdout.len() <= 40);
        assert!(!result.stdout.contains('\u{fffd}'));
        assert!(result.stdout.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn replaces_invalid_bytes_without_panicking_or_exceeding_the_cap() {
        let result = shell(
            "printf '\\377\\376ok'",
            Duration::from_secs(1),
            Duration::from_millis(100),
            64,
        );
        assert!(result.ok);
        assert!(result.stdout.contains('\u{fffd}'));
        assert!(result.stdout.len() <= 64);
    }

    #[test]
    fn timeout_allows_sigterm_before_escalation() {
        let result = shell(
            "trap 'exit 0' TERM; while :; do :; done",
            Duration::from_millis(50),
            Duration::from_millis(500),
            1024,
        );
        assert!(!result.ok);
        assert_eq!(result.code, 124);
        assert!(result.stderr.contains("terminated with SIGTERM"));
        assert!(!result.stderr.contains("SIGKILL"));
    }

    #[test]
    fn timeout_escalates_an_ignoring_process_group_to_sigkill() {
        let result = shell(
            "trap '' TERM; while :; do :; done",
            Duration::from_millis(50),
            Duration::from_millis(50),
            1024,
        );
        assert!(!result.ok);
        assert_eq!(result.code, 124);
        assert!(result.stderr.contains("escalated to SIGKILL"));
    }
}
