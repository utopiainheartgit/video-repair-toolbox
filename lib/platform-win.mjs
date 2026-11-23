// Windows implementation of the native desktop interfaces.
//
// All user-controlled strings are passed through ENVIRONMENT VARIABLES, not
// interpolated into the PowerShell source. This avoids every quoting hazard
// (paths with quotes, $, backticks, Chinese characters) and keeps the script
// itself ASCII-only, which PowerShell parses reliably regardless of the
// machine's OEM code page. Output is forced to UTF-8 so Chinese paths survive
// the trip back to Node.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

const CANCEL = '__VT_CANCEL__';
const OK = '__VT_OK__';
const FAIL = '__VT_FAIL__';
const ERR = '__VT_ERR__';

const VIDEO_FILTER = '视频文件|*.mp4;*.m4v;*.mov;*.mkv;*.avi;*.webm;*.flv;*.wmv;*.mpg;*.mpeg;*.ts;*.m2ts;*.mts;*.3gp;*.3g2;*.ogv;*.vob;*.divx;*.f4v;*.rm;*.rmvb;*.asf;*.mxf|所有文件|*.*';

const HEAD = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nAdd-Type -AssemblyName System.Windows.Forms\n';

// Exported so tests can verify the generated PowerShell on a non-Windows host.
// Scripts contain no user data — every dynamic value is read from $env:*.
export const SCRIPTS = {
  pickFolder: `${HEAD}$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:VTOOL_PROMPT
$d.ShowNewFolderButton = $false
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { Write-Output '${CANCEL}' }
$d.Dispose()`,

  pickFiles: (multiple) => `${HEAD}$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $${multiple ? 'true' : 'false'}
$d.Title = $env:VTOOL_PROMPT
$d.Filter = $env:VTOOL_FILTER
$d.CheckFileExists = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } } else { Write-Output '${CANCEL}' }
$d.Dispose()`,

  pickSave: `${HEAD}$d = New-Object System.Windows.Forms.SaveFileDialog
$d.FileName = $env:VTOOL_DEFAULT
$d.Title = $env:VTOOL_PROMPT
$d.Filter = $env:VTOOL_FILTER
$d.DefaultExt = 'mp4'
$d.OverwritePrompt = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName } else { Write-Output '${CANCEL}' }
$d.Dispose()`,

  reveal: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = $env:VTOOL_PATH
if (Test-Path -LiteralPath $p) {
  Start-Process explorer.exe -ArgumentList ('/select,"' + $p + '"') | Out-Null
  Write-Output '${OK}'
} else { Write-Output '${FAIL}' }`,

  trash: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName Microsoft.VisualBasic
$p = $env:VTOOL_PATH
try {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $p,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
  if (Test-Path -LiteralPath $p) { Write-Output '${FAIL}' } else { Write-Output '${OK}' }
} catch {
  Write-Output ('${ERR}' + $_.Exception.Message.Replace("\`r", ' ').Replace("\`n", ' '))
}`,
};

function powershell(script, env = {}, timeout = 300_000) {
  return new Promise((resolve) => {
    const bin = process.env.POWERSHELL_BIN || 'powershell.exe';
    // pwsh (PowerShell 7+) is STA by default on Windows and rejects -STA.
    const sta = /pwsh/i.test(bin) ? [] : ['-STA'];
    let child;
    try {
      child = spawn(bin, [...sta, '-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: `无法启动 PowerShell：${e.message}` });
    }
    let out = '', err = '', done = false;
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: '原生窗口超时（5 分钟）' });
    }, timeout);
    child.on('error', (e) => finish({ ok: false, error: `无法启动 PowerShell：${e.code || e.message}` }));
    child.on('close', (code) => {
      const lines = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.some((l) => l === CANCEL)) return finish({ ok: false, cancelled: true });
      const errLine = lines.find((l) => l.startsWith(ERR));
      if (errLine) return finish({ ok: false, reason: errLine.slice(ERR.length) || err.trim() });
      if (code !== 0 && !lines.length) {
        return finish({ ok: false, error: err.trim() || `PowerShell 退出码 ${code}` });
      }
      finish({ ok: true, lines, raw: out.trim() });
    });
  });
}

export function pickFolder() {
  return powershell(SCRIPTS.pickFolder, { VTOOL_PROMPT: '选择要扫描的视频文件夹' }).then((r) => {
    if (!r.ok) return r;
    const path = r.lines[r.lines.length - 1];
    return path ? { ok: true, path } : { ok: false, error: '未取得文件夹路径' };
  });
}

export function pickFiles(multiple) {
  return powershell(SCRIPTS.pickFiles(!!multiple), {
    VTOOL_PROMPT: multiple ? '选择视频文件（可多选）' : '选择一个参考视频（同设备录制的完好文件）',
    VTOOL_FILTER: VIDEO_FILTER,
  }).then((r) => (r.ok ? { ok: true, paths: r.lines } : r));
}

export function pickSave(defaultName) {
  return powershell(SCRIPTS.pickSave, {
    VTOOL_DEFAULT: String(defaultName || 'merged.mp4'),
    VTOOL_PROMPT: '保存合并后的视频',
    VTOOL_FILTER: 'MP4 视频|*.mp4|MKV 视频|*.mkv|所有文件|*.*',
  }).then((r) => {
    if (!r.ok) return r;
    const path = r.lines[r.lines.length - 1];
    return path ? { ok: true, path } : { ok: false, error: '未取得保存路径' };
  });
}

export function reveal(file) {
  return powershell(SCRIPTS.reveal, { VTOOL_PATH: file }, 20_000)
    .then((r) => r.ok && r.lines.includes(OK));
}

/**
 * Move a file to the Windows Recycle Bin. Unlike macOS there is no per-volume
 * trash path to compute — the Shell API handles volumes itself — and the same
 * "never unlink" contract as the macOS implementation is preserved.
 * Returns { ok, via?, reason? }.
 */
export async function moveToTrash(file) {
  const st = await stat(file).catch(() => null);
  if (!st) return { ok: false, reason: '文件不存在' };
  if (!st.isFile()) return { ok: false, reason: '不是普通文件' };

  const r = await powershell(SCRIPTS.trash, { VTOOL_PATH: file }, 60_000);
  if (!r.ok) return { ok: false, reason: r.reason || r.error || '回收站调用失败' };
  if (r.lines.includes(OK)) return { ok: true, via: 'recycle-bin' };
  return { ok: false, reason: '文件仍在原位，回收站可能未接受该文件' };
}
