// The workspace sample library (local folders plus installed packs) and pack
// downloads. The backend watches samples/ and this reloads the engines.

import { adapters } from '$lib/adapters';
import * as ipc from '$lib/ipc';
import { addLog } from '$lib/log.svelte';

export class SampleLibrary {
  sounds = $state<ipc.Sound[]>([]);
  packs = $state<ipc.InstalledPack[]>([]);
  catalogue = $state<ipc.CatalogueEntry[]>([]);
  /** Installs in flight, by pack id. */
  progress = $state<Record<string, ipc.PackProgress>>({});
  /** Last install error, by pack id. */
  errors = $state<Record<string, string>>({});
  managerOpen = $state(false);

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private listening = false;

  async init() {
    if (!this.listening) {
      this.listening = true;
      void ipc.onSamplesChanged(() => {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), 400);
      });
      void ipc.onPackProgress((p) => {
        if (this.progress[p.id]) this.progress[p.id] = p;
      });
    }
    this.catalogue = await ipc.packCatalogue();
    await this.refresh();
  }

  async refresh() {
    let library: ipc.Library;
    try {
      library = await ipc.sampleLibrary();
    } catch (err) {
      addLog('samples', `Couldn't scan samples: ${err}`, 'error');
      return;
    }
    this.sounds = library.sounds;
    this.packs = library.packs;
    const files = library.sounds.reduce((n, s) => n + s.files.length, 0);
    const origins = new Set(library.sounds.map((s) => s.origin));
    addLog('samples', `${library.sounds.length} sounds, ${files} files from ${[...origins].join(', ') || 'nowhere yet'}`);
    await Promise.all(
      adapters.map((a) =>
        a.loadSamples?.(library.sounds).catch((err) => addLog(a.id, `Loading samples failed: ${err}`, 'error')),
      ),
    );
  }

  installed(id: string) {
    return this.packs.find((p) => p.id === id);
  }

  async install(id: string, name: string, source: string) {
    if (this.progress[id]) return;
    delete this.errors[id];
    this.progress[id] = { id, done: 0, total: 0, failed: 0 };
    addLog('samples', `Downloading ${name} from ${source}`);
    try {
      await ipc.installPack(id, name, source);
      addLog('samples', `Installed ${name}`);
    } catch (err) {
      const message = String(err);
      if (message !== 'cancelled') this.errors[id] = message;
      addLog('samples', `${name}: ${message}`, message === 'cancelled' ? 'info' : 'error');
    } finally {
      delete this.progress[id];
    }
    await this.refresh();
  }

  /** Installs from a `github:user/repo` or manifest URL typed by the user. */
  async installCustom(source: string) {
    source = source.trim();
    if (!source) return;
    const id = await ipc.packIdFor(source);
    if (!id) return addLog('samples', `Can't name a pack for ${source}`, 'error');
    await this.install(id, id, source);
  }

  cancel(id: string) {
    void ipc.cancelPack(id);
  }

  async remove(id: string) {
    try {
      await ipc.deletePack(id);
    } catch (err) {
      addLog('samples', `Couldn't delete ${id}: ${err}`, 'error');
    }
    await this.refresh();
  }

  /** Plays a sample through the Strudel engine, whatever the track's language. */
  async preview(sound: string, n: number) {
    const engine = adapters.find((a) => a.preview);
    try {
      await engine?.preview?.(sound, n);
    } catch (err) {
      addLog('samples', `Preview of ${sound}:${n} failed: ${err}`, 'error');
    }
  }
}
