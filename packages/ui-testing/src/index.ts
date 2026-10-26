export * from './contracts.js';
export * from './validation.js';
export * from './store.js';
export * from './environment.js';
export * from './recording.js';
export * from './design.js';
export * from './review.js';
export * from './diagnostics.js';
export * from './runtime-admission.js';
export * from './runner.js';
export * from './results.js';
export * from './analysis.js';
export * from './result-review.js';
export * from './workflow.js';
export * from './trace-evidence.js';
export * from './recovery.js';
export * from './maintenance.js';

// 宿主录制适配复用同一过滤器；仅导出实现，不自动开放录制入口。
export { PrivateEvidence } from './private-evidence.js';

// 受信宿主与 fixture 复用同一采集，不自动开放私密 MCP 动作。
export { observePrivateStorage, readPrivateStorageEvents } from './private-recording-storage-events.js';
export { installPrivateRecordingCapture } from './recording-capture.js';
