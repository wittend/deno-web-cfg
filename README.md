## !!! Do NOT Use! WORK IN PROGESS!  
#### Expect Dire consequences if you run this! 
#### Completly UNTESTED!

# TOML Config Editor (Deno)
#### A project to allow creation, editing, and saving TOML configuration files on machines running ka9q (phil karn)'s ka9q-radio servers.

A minimal local web app to view and edit TOML-based “.conf” files using your browser. It:
- Opens any .conf file under a chosen root directory, or falls back to a .conf.example / .conf.template if the target file doesn’t exist.
- Renders nested objects/arrays into an HTML form with sensible field types (booleans, numbers, date, datetime-local, color, email, url, password).
- Supports a “best-effort” preserve-format mode that patches scalar values into the original TOML text to keep comments and layout.
- Lets you save changes back to the original file or “Save As” to a new path.
- Offers a directory browser to discover config files.
- Supports basic validation via a small, pluggable schema (min/max, pattern, enum, required, type hints).
- Can enable Basic Auth when exposed beyond localhost.


## Table of Contents
- Features
- Quick Start
- Installing Deno on Debian/Ubuntu
- Running the App
- Usage
- Validation Schema
- Preserve Formatting and Comments
- Security and Permissions
- Systemd Service (optional)
- Optional Basic Auth

## Quick Start
- Install Deno (instructions below)
- Run:
    - deno run --allow-read --allow-write --allow-net main.ts --root=.

- Open [http://localhost:8787](http://localhost:8787)

## Installing Deno on Debian/Ubuntu
Choose one of the methods below.
1. Official install script (recommended for latest Deno)

- Prerequisites: curl, unzip
- Steps:
``` bash
sudo apt update
sudo apt install -y curl unzip

# Install the latest Deno
curl -fsSL https://deno.land/install.sh | sh

# Add Deno to your shell profile (if not added automatically)
# Replace ~/.bashrc with your preferred shell rc file (e.g., ~/.zshrc)
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
# Reload your shell config or open a new terminal
source ~/.bashrc

# Verify
deno --version
```
1. Using Homebrew on Linux (if you already use Homebrew)
``` bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install deno
deno --version
```
1. Using Cargo (Rust toolchain required; usually slower, but fully from source)
``` bash
# Install Rust if you don't have it
curl https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"

cargo install deno --locked
deno --version
```
Note: Debian/Ubuntu repositories may have a “deno” package, but it can be outdated. Prefer the official script or Homebrew for the latest version.
## Running the App
From the project root:
``` bash
# Basic run (serves on http://localhost:8787)
deno run --allow-read --allow-write --allow-net main.ts --root=.

# Change port
deno run --allow-read --allow-write --allow-net main.ts --root=. --port=8080

# Enable Basic Auth (username: admin, password: s3cret)
deno run --allow-read --allow-write --allow-net main.ts --root=. --auth=admin:s3cret
```
Required permissions:
- --allow-read to read config files under the root
- --allow-write to write changes
- --allow-net to serve HTTP

## Usage
- Home: [http://localhost:8787](http://localhost:8787)
    - Enter a relative path to a .conf under the configured --root.
    - If the file doesn’t exist, the app attempts .conf.example or .conf.template.

- Browse: [http://localhost:8787/browse](http://localhost:8787/browse)
    - Lists all .conf, .conf.example, and .conf.template files under --root.

- Edit page:
    - Form shows existing values, with HTML5 inputs for common types.
    - Arrays support adding/removing items.
    - “Preserve formatting and comments” attempts to patch scalar values into the original text.
    - “Save” overwrites the original file (or the template/example if original doesn’t exist).
    - “Save As…” writes to a new file.

## Validation Schema
The app includes a small, pluggable schema keyed by dotted paths (e.g., server.port, admin.email). Each rule can define:
- type: string | number | boolean | date | datetime-local | color | email | url | password
- required: boolean
- min/max: numeric constraints
- pattern: regex string for inputs
- enum: array of string options (render as select in future; currently provides hints)
- step: number input step
- title/placeholder: display hints

Example rule ideas:
``` typescript
// In code, extend the SCHEMA object:
{
  "server.port": { type: "number", min: 1, max: 65535, step: 1, required: true, title: "Port" },
  "server.host": { type: "string", required: true, placeholder: "0.0.0.0" },
  "admin.email": { type: "email", required: true },
  "theme.accent": { type: "color" },
  "auth.enabled": { type: "boolean" },
  "auth.username": { type: "string", required: true },
  "auth.password": { type: "password", required: true }
}
```
You can expand this schema to enforce domain-specific rules and improve form fidelity.
## Preserve Formatting and Comments
When “Preserve formatting and comments” is enabled:
- The app parses the original TOML and tries to patch only scalar values (booleans, numbers, strings) in place, preserving lines, comments, and spacing.
- If a key can’t be safely located or if complex changes are required (arrays, nested tables added/removed), the app falls back to standard re-stringification.
- This is a best-effort approach. For full fidelity including arrays/tables and nuanced formatting, consider integrating a TOML library that supports true round-trip preservation.

## Security and Permissions
- Root sandbox: The app restricts file operations to the directory passed via --root, preventing path traversal outside of that directory.
- Permissions: Deno’s permission model ensures the app can only read/write and open a network port if you grant the corresponding flags.
- Basic Auth: Enable with --auth=user:pass to require credentials for all endpoints. For production, run behind HTTPS (e.g., reverse proxy) to protect credentials in transit.
- Exposure: If you expose beyond localhost, strongly consider:
    - Enabling Basic Auth
    - Restricting firewall access
    - Running behind a reverse proxy with TLS
    - Using a system service account with limited privileges

## Systemd Service (optional)
Run the editor as a service on Debian/Ubuntu.
1. Create a dedicated user (optional but recommended):
``` bash
sudo useradd -r -s /usr/sbin/nologin confedit
sudo mkdir -p /opt/conf-editor
sudo chown confedit:confedit /opt/conf-editor
```
1. Place project files in /opt/conf-editor (or bind-mount your repo there), owned by confedit.
2. Create a systemd unit file:
``` ini
# /etc/systemd/system/toml-config-editor.service
[Unit]
Description=TOML Config Editor (Deno)
After=network-online.target
Wants=network-online.target

[Service]
User=confedit
WorkingDirectory=/opt/conf-editor
# Ensure Deno is in PATH for this user; or use the absolute path to deno binary
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/confedit/.deno/bin
ExecStart=/home/confedit/.deno/bin/deno run --allow-read --allow-write --allow-net main.ts --root=/opt/conf-editor/config --port=8787 --auth=admin:s3cret
Restart=on-failure
RestartSec=3

# Hardening (adjust as needed)
AmbientCapabilities=
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectControlGroups=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
MemoryDenyWriteExecute=true
LockPersonality=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
```
1. Reload and start:
``` bash
sudo systemctl daemon-reload
sudo systemctl enable toml-config-editor.service
sudo systemctl start toml-config-editor.service
sudo systemctl status toml-config-editor.service
```
If using Basic Auth or sensitive configs, prefer running behind an HTTPS reverse proxy (Nginx, Caddy, etc.).
## Development
- Run with logging in your terminal:
    - deno run --allow-read --allow-write --allow-net main.ts --root=.

- Consider adding a schema for your specific keys to improve input types and validation.
- For debugging TOML parsing issues, print the parsed object or capture server logs.
- For local TLS testing, use a reverse proxy or self-signed certs; Deno’s standard HTTP serve is plain HTTP.

## FAQ
- Does it preserve comments perfectly?
    - Not always. The “preserve formatting” mode works best for scalar updates. Complex structural changes revert to clean re-stringification (comments/formatting may be lost in those cases).

- Can I edit files outside the root?
    - No. The app enforces a root directory sandbox. Pass a different --root to work elsewhere.

- What about other config formats?
    - This app targets TOML. You could add parsers for YAML/JSON and switch based on extension, but that’s beyond the current scope.

- How do I add custom validation or enums?
    - Extend the schema object with rules keyed by dotted paths. You can also adapt the renderer to emit elements when enum is present.LicenseMIT (or your preferred license)If you run into issues or have feature requests, please open an issue or share details about your config structure and desired validation rules.
