# `@seedrop/kernel`

Seedrop v2's transport-neutral command execution boundary.

TR-02 establishes only the package contract: this is the sole package that may
execute state-changing v2 commands, and it imports identifiers, versions, command
phases, and audit meaning from `@seedrop/protocol`. The transaction executor and
recovery implementation arrive later in Wave 3.

This package is shadow-only. It is not connected to the v1 CLI, MCP, View, passport,
Space, Bench, Observer, or Desktop writers.
