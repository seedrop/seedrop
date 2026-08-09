type Tone = "good" | "warn" | "bad";

export function HealthStrip(props: {
  daemonOk: boolean;
  mcpOk: boolean | null;
  runtimeOk: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="health-strip">
      <Chip label="Daemon" tone={props.daemonOk ? "good" : "bad"} onClick={props.onOpen} />
      <Chip
        label="Agents"
        tone={props.mcpOk === null ? "warn" : props.mcpOk ? "good" : "bad"}
        onClick={props.onOpen}
      />
      <Chip label="Runtime" tone={props.runtimeOk ? "good" : "bad"} onClick={props.onOpen} />
    </div>
  );
}

function Chip(props: { label: string; tone: Tone; onClick: () => void }) {
  return (
    <button type="button" className="health-chip" onClick={props.onClick}>
      <span className={`dot ${props.tone === "good" ? "" : props.tone}`} />
      {props.label}
    </button>
  );
}
