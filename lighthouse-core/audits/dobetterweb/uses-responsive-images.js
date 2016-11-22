/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Audits a page to see if it is requesting the geolocation API on
 * page load. This is often a sign of poor user experience because it lacks context.
 */

'use strict';

const Audit = require('../audit');
const Formatter = require('../../formatters/formatter');

const MOBILE_PASS_NAME = Audit.DEFAULT_PASS;
const DESKTOP_PASS_NAME = 'dbw';
const MINIMUM_IMAGE_THRESHOLD = 1024 * 100; // 100kb minimum to trigger
const MINIMUM_DELTA = 1024 * 10; // mobile must be 10kb smaller

class UsesResponsiveImages extends Audit {
  /**
   * @param {!Array} records
   * @return {Number}
   */
  static _filterImageSizes(records) {
    return records.reduce((sizes, record) => {
      if (/^image\//.test(record._mimeType)) {
        sizes.push(record._transferSize);
      }

      return sizes;
    }, []);
  }

  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'CSS',
      name: 'uses-responsive-images',
      description: 'Site offers multiple image sizes depending on device.',
      helpText: 'Use <a href="https://developers.google.com/web/fundamentals/design-and-ui/media/images#responsive-images" target="_blank">responsive image techniques</a> such as <code>img srcset</code> and <code>&lt;picture></code> to reduce the network impact of images.',
      requiredArtifacts: ['networkRecords']
    };
  }

  /**
   * @param {!Artifacts} artifacts
   * @return {!AuditResult}
   */
  static audit(artifacts) {
    if (typeof artifacts.networkRecords !== 'object') {
      return UsesResponsiveImages.generateAuditResult({
        rawValue: -1,
        debugString: 'Network gatherer did not run'
      });
    }

    const mobileNetworkRecords = artifacts.networkRecords[MOBILE_PASS_NAME];
    const desktopNetworkRecords = artifacts.networkRecords[DESKTOP_PASS_NAME];

    if (!Array.isArray(mobileNetworkRecords) || !Array.isArray(desktopNetworkRecords)) {
      return UsesResponsiveImages.generateAuditResult({
        rawValue: -1,
        debugString: 'Response image audit requires both a mobile and desktop pass.'
      });
    }

    const mobileImageSizes = UsesResponsiveImages._filterImageSizes(mobileNetworkRecords);
    const desktopImageSizes = UsesResponsiveImages._filterImageSizes(desktopNetworkRecords);
    const mobileDataTransfer = mobileImageSizes.reduce((a, b) => a + b, 0);
    const desktopDataTransfer = desktopImageSizes.reduce((a, b) => a + b, 0);

    const numKilobytes = Math.round((desktopDataTransfer - mobileDataTransfer) / 1024);
    const rawValue = mobileDataTransfer < MINIMUM_IMAGE_THRESHOLD ||
        mobileDataTransfer < (desktopDataTransfer - MINIMUM_DELTA);
    const displayValue = `${mobileImageSizes.length} images were ${numKilobytes}kb smaller.`;

    return UsesResponsiveImages.generateAuditResult({
      displayValue,
      rawValue,
    });
  }

}

module.exports = UsesResponsiveImages;
