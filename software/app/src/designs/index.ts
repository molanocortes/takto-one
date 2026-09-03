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
import { design as d32 } from './32-editorial';
import { design as d33 } from './33-blueprint';
import { design as d34 } from './34-hud';
import { design as d35 } from './35-atelier';
import { design as d36 } from './36-clinic';
import { design as d37 } from './37-watch';
import { design as d38 } from './38-brutal';
import { design as d39 } from './39-atlas';
import { design as d40 } from './40-monoline';

export const DESIGNS: Record<string, Design> = {
  [d30.id]: d30,
  [d31.id]: d31,
  [d32.id]: d32,
  [d33.id]: d33,
  [d34.id]: d34,
  [d35.id]: d35,
  [d36.id]: d36,
  [d37.id]: d37,
  [d38.id]: d38,
  [d39.id]: d39,
  [d40.id]: d40,
};

export const DEFAULT_DESIGN = '31';

export function pickDesign(): Design {
  const id = urlParams().design;
  return (id && DESIGNS[id]) || DESIGNS[DEFAULT_DESIGN] || d30;
}
