import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const mode = process.argv[2] ?? 'check';
const isWindows = process.platform === 'win32';
const venvPython = path.join(root, '.venv', isWindows ? 'Scripts/python.exe' : 'bin/python');
const healthScript = path.join(root, 'scripts', 'reframe_per_clip.py');

function mediaBinary(name) {
  const configured = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH']?.trim();
  if (configured) return configured;
  const executable = isWindows ? `${name}.exe` : name;
  const local = path.join(root, '.tools', 'ffmpeg', 'bin', executable);
  return existsSync(local) ? local : name;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
}

function works(command, args = []) {
  const result = run(command, [...args, '--version']);
  return result.status === 0;
}

function basePython() {
  const configured = process.env.SMART_REFRAME_PYTHON?.trim();
  const userPython = isWindows && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe')
    : null;
  const candidates = [
    configured ? { command: configured, args: [] } : null,
    userPython && existsSync(userPython) ? { command: userPython, args: [] } : null,
    isWindows ? { command: 'py', args: ['-3.11'] } : null,
    { command: isWindows ? 'python' : 'python3', args: [] },
    !isWindows ? { command: 'python', args: [] } : null,
  ].filter(Boolean);

  return candidates.find((candidate) => works(candidate.command, candidate.args));
}

function health() {
  if (!existsSync(venvPython)) return false;
  const result = run(venvPython, [healthScript, '--health']);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Subject detector health check failed.\n');
    return false;
  }
  process.stdout.write(`${result.stdout.trim()}\n`);
  return true;
}

function mediaHealth() {
  const ffmpeg = run(mediaBinary('ffmpeg'), ['-version']);
  const ffprobe = run(mediaBinary('ffprobe'), ['-version']);
  if (ffmpeg.status === 0 && ffprobe.status === 0) return true;
  console.error('FFmpeg/FFprobe are not ready. Install them or set FFMPEG_PATH and FFPROBE_PATH.');
  return false;
}

if (mode === 'check') {
  if (!health() || !mediaHealth()) {
    console.error('Subject-aware reframing is not ready. Run: npm run reframe:setup');
    process.exit(1);
  }
  process.exit(0);
}

const python = basePython();
if (!python) {
  console.error('Python 3.11 is required. Install it, then run this command again.');
  process.exit(1);
}

if (!existsSync(venvPython)) {
  const create = run(python.command, [...python.args, '-m', 'venv', '.venv'], { inherit: true });
  if (create.status !== 0) process.exit(create.status ?? 1);
}

const requirements = mode === 'worker' ? 'requirements-worker.txt' : 'requirements-reframe.txt';
const install = run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { inherit: true });
if (install.status !== 0) process.exit(install.status ?? 1);

const dependencies = run(venvPython, ['-m', 'pip', 'install', '-r', requirements], { inherit: true });
if (dependencies.status !== 0) process.exit(dependencies.status ?? 1);

if (!health() || !mediaHealth()) process.exit(1);
console.log(`Subject-aware reframing is ready: ${venvPython}`);
