import { contextBridge, ipcRenderer } from 'electron';
import { createApi } from '../shared/ipc';
import type { IpcChannel, IpcArgs, IpcResult } from '../shared/ipc';

// Electron 的 invoke 自身返回 Promise<any>；将它限制在传输边界，页面端使用完整接口定义。
const api = createApi(<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> =>
  ipcRenderer.invoke(channel, ...args));
contextBridge.exposeInMainWorld('api', api);

export type { Api } from '../shared/ipc';
