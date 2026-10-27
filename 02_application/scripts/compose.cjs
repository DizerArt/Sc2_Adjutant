// Use the repository-local compiler when present, otherwise the developer's configured Rust.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const repository = path.dirname(root);
const env = { ...process.env };
const tools = path.join(repository, '.compose-tools');
const systemCargo = path.join(os.homedir(), '.cargo/bin');
if (fs.existsSync(path.join(systemCargo, 'cargo.exe'))) {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${systemCargo}${path.delimiter}${env[pathKey] || ''}`;
} else if (fs.existsSync(path.join(tools, 'cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = path.join(tools, 'cargo');
  env.RUSTUP_HOME = path.join(tools, 'rustup');
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${path.join(tools, 'cargo/bin')}${path.delimiter}${env[pathKey] || ''}`;
}
const command = process.argv[2];
if (!['dev', 'build', 'check', 'test', 'fmt', 'clippy'].includes(command)) throw new Error('Unknown compose build action');
const cargoArgs = {
  check: ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--locked'],
  test: ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-default-features', '--locked'],
  fmt: ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'],
  clippy: ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--locked', '--', '-D', 'warnings']
};
const executable = command === 'dev' || command === 'build' ? process.execPath : (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const args = command === 'dev' || command === 'build'
  ? [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), command, ...process.argv.slice(3)]
  : [...cargoArgs[command], ...process.argv.slice(3)];
const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
