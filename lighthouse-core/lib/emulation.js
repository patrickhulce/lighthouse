/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const DEFAULT_EMULATION_METRICS = {
  positionX: 0,
  positionY: 0,
  scale: 1,
  fitWindow: false,
};

const MOBILE_EMULATION_METRICS = Object.assign({
  mobile: true,
  screenOrientation: {
    angle: 0,
    type: 'portraitPrimary'
  }
}, DEFAULT_EMULATION_METRICS);

/**
 * Nexus 5X metrics adapted from emulated_devices/module.json
 */
const NEXUS5X_EMULATION_METRICS = Object.assign({
  screenWidth: 412,
  screenHeight: 732,
  width: 412,
  height: 732,
  deviceScaleFactor: 2.625,
}, MOBILE_EMULATION_METRICS);

const IPHONE4_EMULATION_METRICS = Object.assign({
  screenWidth: 320,
  screenHeight: 480,
  width: 320,
  height: 480,
  deviceScaleFactor: 1,
}, MOBILE_EMULATION_METRICS);

const IPAD4_EMULATION_METRICS = Object.assign({
  screenWidth: 768,
  screenHeight: 1024,
  width: 1024,
  height: 1366,
  deviceScaleFactor: 2,
}, MOBILE_EMULATION_METRICS)

const NEXUS5X_USERAGENT = {
  userAgent: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5 Build/MRA58N) AppleWebKit/537.36' +
    '(KHTML, like Gecko) Chrome/52.0.2743.8 Mobile Safari/537.36'
};

const IPHONE4_USERAGENT = {
  userAgent: 'Iphone 4'
};

const IPAD4_USERAGENT = {
  userAgent: 'iPad 4'
};

const DESKTOP_USERAGENT = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36' +
    '(KHTML, like Gecko) Chrome/54.0.2840.98 Safari/537.36'
}

const TYPICAL_MOBILE_THROTTLING_METRICS = {
  latency: 150, // 150ms
  downloadThroughput: Math.floor(1.6 * 1024 * 1024 / 8), // 1.6Mbps
  uploadThroughput: Math.floor(750 * 1024 / 8), // 750Kbps
  offline: false
};

const OFFLINE_METRICS = {
  offline: true,
  // values of 0 remove any active throttling. crbug.com/456324#c9
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0
};

const NO_THROTTLING_METRICS = {
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
  offline: false
};

const NO_CPU_THROTTLE_METRICS = {
  rate: 1
};
const CPU_THROTTLE_METRICS = {
  rate: 5
};

function enableDeviceEmulation(driver) {
  /**
   * Finalizes touch emulation by enabling `"ontouchstart" in window` feature detect
   * to work. Messy hack, though copied verbatim from DevTools' emulation/TouchModel.js
   * where it's been working for years. addScriptToEvaluateOnLoad runs before any of the
   * page's JavaScript executes.
   */
  /* eslint-disable no-proto */ /* global window, document */ /* istanbul ignore next */
  const injectedTouchEventsFunction = function() {
    const touchEvents = ['ontouchstart', 'ontouchend', 'ontouchmove', 'ontouchcancel'];
    var recepients = [window.__proto__, document.__proto__];
    for (var i = 0; i < touchEvents.length; ++i) {
      for (var j = 0; j < recepients.length; ++j) {
        if (!(touchEvents[i] in recepients[j])) {
          Object.defineProperty(recepients[j], touchEvents[i], {
            value: null, writable: true, configurable: true, enumerable: true
          });
        }
      }
    }
  };
  /* eslint-enable */

  return Promise.all([
    // Network.enable must be called for UA overriding to work later
    driver.sendCommand('Network.enable'),
    driver.sendCommand('Page.addScriptToEvaluateOnLoad', {
      scriptSource: '(' + injectedTouchEventsFunction.toString() + ')()'
    })
  ]);
}

function setDeviceMetrics(driver, metrics, useragent) {
  return Promise.all([
    driver.sendCommand('Network.setUserAgentOverride', useragent),
    driver.sendCommand('Emulation.setDeviceMetricsOverride', metrics),
    driver.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      configuration: 'mobile'
    }),
  ]);
}

function clearDeviceEmulation(driver) {
  return Promise.all([
    driver.sendCommand('Network.setUserAgentOverride', DESKTOP_USERAGENT),
    driver.sendCommand('Emulation.clearDeviceMetricsOverride'),
    driver.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: false,
      configuration: 'desktop'
    }),
  ]);
}

function emulateNexus5X(driver) {
  return setDeviceMetrics(driver, NEXUS5X_EMULATION_METRICS, NEXUS5X_USERAGENT);
}

function emulateiPhone4(driver) {
  return setDeviceMetrics(driver, IPHONE4_EMULATION_METRICS, IPHONE4_USERAGENT);
}

function emulateiPad4(driver) {
  return setDeviceMetrics(driver, IPAD4_EMULATION_METRICS, IPAD4_USERAGENT);
}

function enableNetworkThrottling(driver) {
  return driver.sendCommand('Network.emulateNetworkConditions', TYPICAL_MOBILE_THROTTLING_METRICS);
}

function disableNetworkThrottling(driver) {
  return driver.sendCommand('Network.emulateNetworkConditions', NO_THROTTLING_METRICS);
}

function goOffline(driver) {
  return driver.sendCommand('Network.emulateNetworkConditions', OFFLINE_METRICS);
}

function enableCPUThrottling(driver) {
  return driver.sendCommand('Emulation.setCPUThrottlingRate', CPU_THROTTLE_METRICS);
}

function disableCPUThrottling(driver) {
  return driver.sendCommand('Emulation.setCPUThrottlingRate', NO_CPU_THROTTLE_METRICS);
}

module.exports = {
  enableDeviceEmulation,
  clearDeviceEmulation,
  emulateNexus5X,
  emulateiPhone4,
  emulateiPad4,
  enableNetworkThrottling,
  disableNetworkThrottling,
  enableCPUThrottling,
  disableCPUThrottling,
  goOffline
};
