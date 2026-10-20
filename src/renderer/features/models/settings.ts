import type { ModelChoice, SessionView } from '../../../shared/types.js';
import { el } from '../../shared/dom.js';
const api = window.agentClient;

export function bindModelSettings(
  getActive: () => SessionView | null,
  onModels: (models: ModelChoice[]) => void,
  onView: (view: SessionView) => void,
) {
  const settings = el<HTMLDialogElement>('settings-dialog');
  const openSettings = () => {
    if (!document.querySelector('dialog[open]')) settings.showModal();
  };
  el('settings-button').addEventListener('click', openSettings);
  el('close-settings').addEventListener('click', () => settings.close());
  el('refresh-models').addEventListener('click', () => {
    el('model-error').hidden = true;
    void api
      .refreshModels()
      .then((list) => {
        onModels(list);
      })
      .catch((error) => {
        el('model-error').textContent = error instanceof Error ? error.message : String(error);
        el('model-error').hidden = false;
      });
  });
  el<HTMLFormElement>('model-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement,
      data = new FormData(form);
    const save = el<HTMLButtonElement>('save-model');
    save.disabled = true;
    el('model-error').hidden = true;
    void (async () => {
      try {
        const provider = String(data.get('provider')).trim(),
          modelId = String(data.get('modelId')).trim();
        const models = await api.saveModel({
          provider,
          modelId,
          baseUrl: String(data.get('baseUrl')).trim(),
          apiKey: String(data.get('apiKey')).trim(),
          reasoning: data.get('reasoning') === 'on',
        });
        (form.elements.namedItem('apiKey') as HTMLInputElement).value = '';
        onModels(models);
        const active = getActive();
        if (active) onView(await api.setModel(active.id, provider, modelId));
        settings.close();
      } catch (error) {
        el('model-error').textContent = error instanceof Error ? error.message : String(error);
        el('model-error').hidden = false;
      } finally {
        save.disabled = false;
      }
    })();
  });
  return openSettings;
}
