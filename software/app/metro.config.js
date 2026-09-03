// Metro bundler config. The hand GLB is an asset, not a module, on every
// platform: metro must copy it verbatim so expo-asset can hand three.js a
// local URI on native and a URL on web.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('glb')) config.resolver.assetExts.push('glb');
module.exports = config;
