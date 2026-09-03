// designs/index.ts - the design registry.
//
// Twenty complete UI designs coexist in this app so any one can be opened
// and judged beside the others. ?design=NN on the web build selects one;
// DEFAULT_DESIGN is what ships. Each design owns its screens, chrome, tokens
// and twin look in its own folder; the data path, the kinematics, the bridge
// and the GLB loader are shared and never forked.
import type React from 'react';
import type { ScreenKey } from './shared';
import { urlParams } from './shared';

export type DesignProps = { initialScreen: ScreenKey; detail: boolean };

export type Design = {
  id: string;
  slug: string;
  name: string;
  thesis: string;
  /** the fonts this design loads, by the family names its tokens use */
  fonts: Record<string, any>;
  /** the ground colour while fonts load, and the status bar tone */
  bg: string;
  statusBar: 'light-content' | 'dark-content';
  App: React.ComponentType<DesignProps>;
};

import { design as d30 } from './30-baseline';
import { design as d31 } from './31-rams';

export const DESIGNS: Record<string, Design> = {
  [d30.id]: d30,
  [d31.id]: d31,
};

export const DEFAULT_DESIGN = '31';

export function pickDesign(): Design {
  const id = urlParams().design;
  return (id && DESIGNS[id]) || DESIGNS[DEFAULT_DESIGN] || d30;
}
