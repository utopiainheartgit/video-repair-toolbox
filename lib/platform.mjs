// Platform dispatch for the few desktop-native operations the toolbox needs.
// Everything else (diagnosis, repair, merge, queue, UI) is platform-agnostic
// and calls no native code, so adding an OS only means implementing these
// five functions — never touching the repair algorithms.

import * as mac from './platform-mac.mjs';
import * as win from './platform-win.mjs';
import { moveToTrash as macTrash } from './trash.mjs';

export const PLATFORM = process.platform;
export const IS_MAC = PLATFORM === 'darwin';
export const IS_WIN = PLATFORM === 'win32';
export const nativePickerAvailable = () => IS_MAC || IS_WIN;

const unsupported = (name) => async () => ({ ok: false, error: `${name} 暂不支持当前系统（${PLATFORM}）` });

const impl = IS_MAC
  ? {
      pickFolder: mac.pickFolder,
      pickFiles: mac.pickFiles,
      pickSave: mac.pickSave,
      reveal: mac.reveal,
      moveToTrash: macTrash,
    }
  : IS_WIN
    ? {
        pickFolder: win.pickFolder,
        pickFiles: win.pickFiles,
        pickSave: win.pickSave,
        reveal: win.reveal,
        moveToTrash: win.moveToTrash,
      }
    : {
        pickFolder: unsupported('选择文件夹'),
        pickFiles: unsupported('选择文件'),
        pickSave: unsupported('保存对话框'),
        reveal: unsupported('在资源管理器中显示'),
        moveToTrash: async () => ({ ok: false, reason: `当前系统（${PLATFORM}）不支持回收站删除` }),
      };

export const pickFolder = impl.pickFolder;
export const pickFiles = impl.pickFiles;
export const pickSave = impl.pickSave;
export const reveal = impl.reveal;
export const moveToTrash = impl.moveToTrash;

// Testable selector: lets unit tests verify dispatch without mocking globals.
export const activeBackend = IS_MAC ? 'mac' : IS_WIN ? 'win' : 'unsupported';
