import { test as base, expect } from './fixtures.js';
import { installPrivateRecordingCapture } from './recording-capture.js';

/** 复用原 fixture 的身份、前置与清理。page override 先于自动 uiData 导航安装观察。 */
export const test = base.extend({
  page: async ({ page, uiEnvironment, uiProjectRoot }, use, info) => {
    const directory = process.env.PI_UI_PRIVATE_EVIDENCE_DIR;
    if (
      !directory ||
      !uiEnvironment ||
      (info.project.use.trace && info.project.use.trace !== 'off')
    )
      throw new Error(
        'Private recording capture unavailable; private directory and trace:off required',
      );
    const capture = await installPrivateRecordingCapture(
      page,
      uiEnvironment,
      uiProjectRoot,
      directory,
    );
    try {
      await use(page);
    } finally {
      await capture.dispose();
    }
  },
});
export { expect };
