// TAKTO companion - a digital twin and instrument panel for TAKTO ONE.
//
// Three surfaces, one data path, and the same articulated CAD the operator
// console renders: Live (the device now), Replay (a recorded session played
// back into the same twin) and Data (the channels, and where they come from).
// Everything runs with no hardware attached, on a synthetic feed that says so.
//
// The UI is one of the designs in src/designs: ?design=NN picks one on the
// web build, DEFAULT_DESIGN in src/designs/index.ts is the one that ships.
import React, { useEffect, useMemo } from 'react';
import { View, StatusBar, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { pickDesign } from './src/designs';
import { urlParams } from './src/designs/shared';
import { session } from './src/data/session';
import { bundledTakes } from './src/data/takes';

export default function App() {
  const design = useMemo(pickDesign, []);
  const [ready] = useFonts(design.fonts);
  const params = useMemo(urlParams, []);

  useEffect(() => {
    // Deterministic capture, web only: ?screen=welcome|live|replay|data pins
    // the screen, ?t=<seconds> pins the clock, ?take=<id> opens a bundled
    // session, ?detail=1 opens the design's detail state. tools/capture.mjs
    // renders the media in docs/ through these.
    if (Platform.OS === 'web' && typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const takeId = q.get('take');
      if (takeId) {
        const found = bundledTakes().find((t) => t.id === takeId || t.title.toLowerCase() === takeId);
        if (found) session.setTake(found);
      }
      const t = q.get('t');
      if (t !== null && Number.isFinite(Number(t))) session.pin(Number(t));
    }
    session.start();
    return () => session.stop();
  }, []);

  const Shell = design.App;
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={design.statusBar} backgroundColor={design.bg} />
      {ready
        ? <Shell initialScreen={params.screen ?? 'welcome'} detail={params.detail} />
        : <View style={{ flex: 1, backgroundColor: design.bg }} />}
    </SafeAreaProvider>
  );
}
