import { StrudelAdapter } from './strudel/index.svelte';
import { TidalAdapter } from './tidal/index.svelte';
import type { LanguageAdapter } from './types';

export const adapters: LanguageAdapter[] = [new StrudelAdapter(), new TidalAdapter()];

export function adapterFor(path: string): LanguageAdapter | undefined {
  return adapters.find((a) => a.extensions.some((ext) => path.endsWith(ext)));
}

export const trackExtensions = adapters.flatMap((a) => a.extensions);

// Engines hold audio contexts, schedulers and listeners that hot-swapping
// would duplicate, so any change under here reloads the page instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}
