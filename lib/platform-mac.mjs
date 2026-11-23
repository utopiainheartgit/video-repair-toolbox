// macOS implementation of the native desktop interfaces.
// Moved verbatim out of server.mjs so every platform-specific call lives in
// one place; behaviour (including AppleScript escaping and timeout handling)
// is unchanged.

import { spawn } from 'node:child_process';

// Escape a value embedded in an AppleScript double-quoted string. macOS file
// names can contain newlines; without this they break out of the literal.
const asQuoted = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

function runAppleScript(script, { timeout = 0, parse } = {}) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(v); } };
    const timer = timeout > 0 ? setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `原生选择器超时（${Math.round(timeout / 1000)} 秒）` });
    }, timeout) : null;
    child.on('error', () => finish({ ok: false, error: '无法调用 osascript' }));
    child.on('close', (code) => {
      if (code !== 0) {
        return finish({
          ok: false,
          cancelled: /User canceled|-128|canceled/i.test(err),
          error: err.trim() || `osascript 退出码 ${code}`,
        });
      }
      finish(parse ? parse(out) : { ok: true, path: out.trim() });
    });
  });
}

export function pickFolder() {
  return runAppleScript('POSIX path of (choose folder with prompt "选择要扫描的视频文件夹")');
}

export function pickFiles(multiple) {
  const script = multiple
    ? 'set fs to choose file with prompt "选择视频文件（可多选）" with multiple selections allowed\nset o to ""\nrepeat with f in fs\nset o to o & POSIX path of f & linefeed\nend repeat\nreturn o'
    : 'POSIX path of (choose file with prompt "选择一个参考视频（同设备录制的完好文件）")';
  return runAppleScript(script, {
    parse: (out) => ({
      ok: true,
      paths: multiple ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [out.trim()].filter(Boolean),
    }),
  });
}

export function pickSave(defaultName) {
  return runAppleScript(
    `POSIX path of (choose file name with prompt "保存合并后的视频" default name "${asQuoted(defaultName)}")`,
  );
}

export function reveal(file) {
  return runAppleScript(`tell application "Finder"
activate
reveal POSIX file "${asQuoted(file)}"
end tell`, { timeout: 15_000 }).then((r) => r.ok);
}

export { asQuoted };
