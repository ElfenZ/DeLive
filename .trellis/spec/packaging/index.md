# Packaging Guidelines

> Build and packaging rules for generated release artifacts in this project.

---

## Pre-Development Checklist

- [ ] If the task mentions `win-unpacked`, `dist:win`, or Windows installers, read [Windows Packaging](./win-unpacked.md) before running any packaging command.
- [ ] Confirm the working tree has no unrelated generated artifact assumptions; packaging rewrites `frontend/dist`, `dist-electron`, and `release/win-unpacked`.
- [ ] Clear Electron debug/runtime environment variables before smoke-testing a packaged app.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Windows Packaging](./win-unpacked.md) | Rules for updating Windows unpacked, installer, and portable artifacts | Active |

---

## Quality Check

- [ ] The build command used matches the host environment, not just `package.json` defaults.
- [ ] `release/win-unpacked/DeLive.exe` exists after packaging.
- [ ] `release/win-unpacked/resources/app.asar` exists after packaging.
- [ ] The unpacked app has been smoke-tested with `ELECTRON_RUN_AS_NODE` cleared.

---

**Language**: All documentation should be written in **English**.
