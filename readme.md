

# Welcome to Orbit Editor

<div align="center">
	
https://github.com/user-attachments/assets/01c51dec-f037-43d9-b68b-2e3bdc582270

</div>

Use AI agents on your codebase, checkpoint and visualize changes, and bring any model or host locally. Orbit sends messages directly to providers without retaining your data.

This repo contains the full source code for Orbit Editor's desktop app. If you're new, welcome!

- 🌐 [Website](https://orbiteditorai.com)
- 🚙 [Project Board](https://github.com/ashish200729/orbiteditor/projects)
- 🔨 [Contribute](./HOW_TO_CONTRIBUTE.md)

## Download

Orbit Editor is currently in **beta** and available for **macOS** (Apple Silicon and Intel). Windows and Linux support is coming soon.

**Recommended — one-line install (no Gatekeeper warning):**

```bash
curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
```

This downloads and installs Orbit into `/Applications` via `curl`, which never
tags the app with macOS's `com.apple.quarantine` flag — so it launches with **no
Gatekeeper prompt**, on any Mac, with no Apple Developer account required.

**Alternative — download the `.dmg`** from
[Releases](https://github.com/ashish200729/orbiteditor/releases) or
[orbiteditorai.com](https://orbiteditorai.com), then drag Orbit to Applications.
Because Orbit is not (yet) notarized by Apple, a DMG downloaded through a browser
is quarantined and macOS shows *"Apple could not verify Orbit is free of
malware."* Bypass it once, any of:

- Right-click `Orbit.app` → **Open** → **Open Anyway**, or
- System Settings → Privacy & Security → **Open Anyway**, or
- Terminal: `xattr -cr /Applications/Orbit.app`

## Demo

<p align="center">
	<a href="https://orbiteditorai.com"><strong>▶ Watch the full demo on orbiteditorai.com</strong></a>
</p>

## About

Orbit Editor is a fork of [Void Editor](https://github.com/voideditor/void), which itself is a fork of [VS Code](https://github.com/microsoft/vscode). We are grateful to both projects for their excellent foundation.

## Features

- **AI agents** — Run agents that understand your codebase, with support for subagents and configurable tool policies.
- **Bring your own model** — Connect any provider or run models locally. Messages go directly to the provider without retaining your data.
- **Checkpoints & change visualization** — Inspect, revert, and replay edits as you work, with a clear view of what changed and why.
- **Plan mode** — Collaboratively design an implementation approach before any code is written.
- **MCP integration** — Extend agent capabilities with Model Context Protocol servers.
- **Skills** — Reusable, scoped workflows that encode project-specific knowledge and best practices.

## Reference

Orbit Editor is a fork of the [vscode](https://github.com/microsoft/vscode) repository. For a guide to our codebase, see [ORBIT_CODEBASE_GUIDE](./ORBIT_CODEBASE_GUIDE.md).

For a guide on how to develop your own version of Orbit, see [HOW_TO_CONTRIBUTE](./HOW_TO_CONTRIBUTE.md).

Additional feature docs:

- [Plan mode](./docs/plan-mode.md)
- [Subagents](./docs/orbit-subagents.md)
- [macOS release builds](./docs/BUILD_MACOS.md)

## Contributing

1. To get started working on Orbit, check out our [Project Board](https://github.com/ashish200729/orbiteditor/projects)! You can also see [HOW_TO_CONTRIBUTE.md](./HOW_TO_CONTRIBUTE.md).
2. Feel free to open issues and pull requests!
3. Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

## License

Orbit Editor's additions and modifications are licensed under the Apache License 2.0.

The VS Code base is licensed under the MIT License.

The Void Editor base contains both Apache 2.0 and MIT licensed components.

See [LICENSE.txt](./LICENSE.txt), [LICENSE-VS-Code.txt](./LICENSE-VS-Code.txt), and [NOTICE](./NOTICE) for full details.

## Support

You can reach us via [GitHub issues](https://github.com/ashish200729/orbiteditor/issues), join our [Discord server](https://discord.gg/ZPYkjPCDj8) for community support and discussions, or email us at [ashishp.292007@gmail.com](mailto:ashishp.292007@gmail.com).

To report a security vulnerability, see [SECURITY.md](./SECURITY.md).
