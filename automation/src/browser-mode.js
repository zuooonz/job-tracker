const fs = require('fs');
const path = require('path');

function displayNumber(display) {
  const match = String(display || '').match(/^:(\d+)/);
  return match ? match[1] : '';
}

function displayAvailable(display) {
  const number = displayNumber(display);
  return Boolean(number && fs.existsSync(`/tmp/.X11-unix/X${number}`));
}

function detectDisplay() {
  if (displayAvailable(process.env.DISPLAY)) return process.env.DISPLAY;
  try {
    const sockets = fs.readdirSync('/tmp/.X11-unix')
      .filter(name => /^X\d+$/.test(name))
      .map(name => ({
        display: `:${name.slice(1)}`,
        stat: fs.statSync(path.join('/tmp/.X11-unix', name)),
      }))
      .filter(item => item.stat.isSocket() && item.stat.uid === process.getuid())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return sockets[0]?.display || '';
  } catch (_) {
    return '';
  }
}

function detectXAuthority(runtimeDir) {
  if (process.env.XAUTHORITY && fs.existsSync(process.env.XAUTHORITY)) {
    return process.env.XAUTHORITY;
  }
  try {
    return fs.readdirSync(runtimeDir)
      .filter(name => name.startsWith('.mutter-Xwaylandauth.'))
      .map(name => path.join(runtimeDir, name))
      .filter(candidate => fs.existsSync(candidate))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  } catch (_) {
    return '';
  }
}

function prepareBrowserEnvironment() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const display = detectDisplay();
  if (display) process.env.DISPLAY = display;
  process.env.XDG_RUNTIME_DIR ||= runtimeDir;
  const xauthority = detectXAuthority(runtimeDir);
  if (xauthority) process.env.XAUTHORITY = xauthority;
  return { display, runtimeDir, xauthority };
}

function resolveBrowserMode(requested = process.env.BROWSER_MODE || 'auto') {
  const normalized = String(requested).toLowerCase();
  if (normalized === 'headless') return 'headless';
  if (normalized === 'headed') return 'headed';
  return detectDisplay() ? 'headed' : 'headless';
}

// 无头模式的默认 UA 含 HeadlessChrome，需要替换；版本号必须与本机 Chrome 一致，
// 否则 UA 与 Client Hints 不符本身就是风控信号。
function chromeMajorVersion(chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable') {
  try {
    const output = require('child_process').execFileSync(chromePath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return output.match(/(\d+)\./)?.[1] || '';
  } catch (_) {
    return '';
  }
}

function headlessArgs() {
  const major = chromeMajorVersion();
  return [
    '--headless=new', '--disable-dev-shm-usage', '--disable-crash-reporter',
    '--enable-unsafe-swiftshader', '--lang=zh-CN',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(major ? [`--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`] : []),
  ];
}

module.exports = {
  chromeMajorVersion,
  detectDisplay,
  displayAvailable,
  prepareBrowserEnvironment,
  resolveBrowserMode,
  headlessArgs,
};
