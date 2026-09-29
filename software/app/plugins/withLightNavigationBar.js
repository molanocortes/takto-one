// withLightNavigationBar.js - dark navigation-bar buttons on the light page.
//
// The app is edge-to-edge (mandatory from Android 16): the system bars are
// transparent and the warm-grey page draws behind them. expo-status-bar makes
// the STATUS bar icons dark; nothing in the SDK does the same for the
// three-button navigation bar any more, so without this its white buttons sit
// on a near-white page. One theme item, applied at prebuild.
const { withAndroidStyles, AndroidConfig } = require('expo/config-plugins');

module.exports = function withLightNavigationBar(config) {
  return withAndroidStyles(config, (c) => {
    c.modResults = AndroidConfig.Styles.assignStylesValue(c.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: 'android:windowLightNavigationBar',
      value: 'true',
    });
    return c;
  });
};
