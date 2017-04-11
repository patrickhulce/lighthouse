/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

'use strict';

const Audit = require('./audit');
const TracingProcessor = require('../lib/traces/tracing-processor');
const Formatter = require('../report/formatter');

// Parameters (in ms) for log-normal CDF scoring. To see the curve:
//   https://www.desmos.com/calculator/jlrx14q4w8
const SCORING_POINT_OF_DIMINISHING_RETURNS = 1700;
const SCORING_MEDIAN = 5000;
// This aligns with the external TTI targets in https://goo.gl/yXqxpL
const SCORING_TARGET = 5000;

class TTIMetric extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'Performance',
      name: 'time-to-interactive',
      description: 'Time To Interactive (alpha)',
      helpText: 'Time to Interactive identifies the time at which your app appears to be ready ' +
          'enough to interact with. ' +
          '[Learn more](https://developers.google.com/web/tools/lighthouse/audits/time-to-interactive).',
      optimalValue: SCORING_TARGET.toLocaleString() + 'ms',
      scoringMode: Audit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['traces']
    };
  }

  /**
   * Finds a quiet window in main thread activity of windowSize within the bounds of minTime and
   * maxTime where the given percentile of estimated input latency is <50ms.
   *
   * @param {number} minTime Window start must be greater than or equal to this value
   * @param {number} maxTime Window end must be less than or equal to this value
   * @param {!Object} model The trace model from requestTracingModel
   * @param {!Object} trace The trace artifact
   * @param {!Object} options
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static _slidingResponsivenessWindow(
    minTime,
    maxTime,
    model,
    trace,
    options = {}
  ) {
    const threshold = options.threshold || 50;
    const windowSize = options.responsivenessWindowSize || 500;
    const percentile = options.responsivenessPercentile || .9;
    const isForwardSearch = typeof options.isForwardSearch === 'boolean' ?
        options.isForwardSearch : true;
    const networkQuietPeriods = options.networkQuietPeriods;

    let startTime = isForwardSearch ? minTime - 50 : maxTime - windowSize + 50;
    let endTime;
    let done = false;
    let seenGoodEnoughLatency = false;
    let currentLatency = Infinity;
    const percentiles = [percentile]; // [0.75, 0.9, 0.99, 1];
    const foundLatencies = [];

    while (!done) {
      // While latency is too high, move just 50ms and look again.
      startTime = startTime + (isForwardSearch ? 50 : -50);
      endTime = startTime + windowSize;

      // If there's no more room in the trace to look, we're done.
      if (startTime < minTime || endTime > maxTime) {
        let timeInMs = undefined;

        // For reverse search, running out of room means the entire window was responsive.
        if (!isForwardSearch && seenGoodEnoughLatency) {
          timeInMs = minTime;
        }

        return {
          timeInMs,
          currentLatency,
          foundLatencies,
        };
      }

      let estLatency;
      if (percentile === 'long-tasks') {
        estLatency = TracingProcessor.hasLongTask(model, trace, startTime, endTime) ? Infinity : 0;
      } else if (percentile === 'patrick') {
        const earlyDurations = TracingProcessor.getMainThreadTopLevelEventDurations(model, trace, startTime, startTime + 500).durations;
        const durations = TracingProcessor.getMainThreadTopLevelEventDurations(model, trace, startTime, endTime).durations;

        const hasNoneEarly = earlyDurations.filter(x => x > 50).length === 0;
        const has5OrFewer = durations.filter(x => x > 50).length <= 5;
        const hasNoTaskLongerThan100 = durations.filter(x => x > 100).length === 0;
        estLatency = hasNoneEarly && has5OrFewer && hasNoTaskLongerThan100 ? 0 : Infinity;
      } else {
        const latencies = TracingProcessor.getRiskToResponsiveness(
          model, trace, startTime, endTime, percentiles);
        estLatency = latencies[0].time;
      }

      foundLatencies.push({
        estLatency: estLatency,
        startTime: startTime.toFixed(1)
      });

      // Grab this latency and check if we're done yet
      let isGoodEnough = currentLatency <= threshold;
      if (networkQuietPeriods) {
        isGoodEnough = Boolean(isGoodEnough && networkQuietPeriods.find(p => startTime < p.endInMs && endTime > p.startInMs));
      }

      currentLatency = estLatency;
      seenGoodEnoughLatency = seenGoodEnoughLatency || isGoodEnough;

      if (isForwardSearch) {
        // for forward search we slide forward until we move into the threshold
        done = seenGoodEnoughLatency;
      } else {
        // for reverse search, we slide back until we move out of the threshold
        done = seenGoodEnoughLatency && currentLatency > threshold;
      }
    }

    // move the start time back into the threshold region if we're reverse search
    if (!isForwardSearch) {
      startTime = startTime + 50;
    }

    return {
      // The start of our window is our TTI
      timeInMs: startTime,
      currentLatency,
      foundLatencies,
    };
  }

  /**
   * Finds all time periods where there were allowedConcurrentRequests or fewer inflight requests.
   *
   * @param {!Array<{parsedUrl: Object, startTime: number, endTime: number>} networkRecords
   * @param {number=} allowedConcurrentRequests Maximum number of concurrent requests allowed in a
   *    quiet period.
   * @return {!Array<{start: number, end: number>}
   */
  static _findNetworkNQuiet(networkRecords, allowedConcurrentRequests = 2) {
    const timeBoundaries = networkRecords.reduce((boundaries, record) => {
      const scheme = record.parsedURL && record.parsedURL.scheme;
      if (scheme === 'data' || scheme === 'ws') {
        return boundaries;
      }

      boundaries.push({time: record.startTime, isStart: true});
      boundaries.push({time: record.endTime, isStart: false});
      return boundaries;
    }, []).sort((a, b) => a.time - b.time);

    let inflight = 0;
    let quietPeriodStart = 0;
    const quietPeriods = [];
    timeBoundaries.forEach(boundary => {
      if (boundary.isStart) {
        // we are exiting a quiet period
        if (inflight === allowedConcurrentRequests) {
          quietPeriods.push({start: quietPeriodStart, end: boundary.time});
          quietPeriodStart = null;
        }
        inflight++;
      } else {
        inflight--;
        // we are entering a quiet period
        if (inflight === allowedConcurrentRequests) {
          quietPeriodStart = boundary.time;
        }
      }
    });

    // Check if the trace ended in a quiet period
    if (typeof quietPeriodStart === 'number') {
      quietPeriods.push({start: quietPeriodStart, end: Infinity});
    }

    return quietPeriods;
  }

  static _findNetworkNQuietStart(networkRecords, timestamps, n, windowSize) {
    const networkQuietPeriods = TTIMetric._findNetworkNQuiet(networkRecords, n);
    const quietPeriodsAfterFMP = networkQuietPeriods.filter(period => {
      return period.start > timestamps.firstMeaningfulPaint / 1000 &&
        (period.end - period.start) * 1000 > windowSize;
    });

    if (!quietPeriodsAfterFMP.length) {
      return {networkQuietPeriods};
    }

    const start = quietPeriodsAfterFMP[0] && quietPeriodsAfterFMP[0].start * 1000;
    const timing = (start - timestamps.navigationStart) || 0;
    return {networkQuietPeriods, start: start * 1000, timing};
  }

  /**
   * Searches forward until finding a network quiet window, then searches forward for a
   * responsiveness window and returns the start of that window.
   *
   * @param {!Object} times
   * @param {!Object} timestamps
   * @param {!Object} data
   * @param {{allowedConcurrentRequests: number, responsivenessWindowSize: number, percentile: number,
   *    networkWindowSize: number}} options
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array,
   *    networkQuietPeriods: !Array}}
   */
  static _networkForwardSearch(times, timestamps, data, options) {
    const networkQuietPeriods = TTIMetric._findNetworkNQuiet(data.networkRecords,
        options.allowedConcurrentRequests);
    const quietPeriodsAfterFMP = networkQuietPeriods.filter(period => {
      return period.start > timestamps.firstMeaningfulPaint / 1000 &&
        (period.end - period.start) * 1000 > options.networkWindowSize;
    }).map(period => Object.assign(period, {
      startInMs: period.start * 1000 - timestamps.navigationStart,
      endInMs: period.end * 1000 - timestamps.navigationStart
    }));

    if (!quietPeriodsAfterFMP.length) {
      return {networkQuietPeriods};
    }

    const networkQuietStart = quietPeriodsAfterFMP[0] && quietPeriodsAfterFMP[0].startInMs;
    const forwardSearchResult = TTIMetric._slidingResponsivenessWindow(
      Math.max(networkQuietStart, times.firstMeaningfulPaint),
      times.traceEnd,
      data.model,
      data.trace,
      Object.assign({networkQuietPeriods}, options)
    );

    return Object.assign({networkQuietPeriods}, forwardSearchResult);
  }

  /**
   * Searches forward until finding a network quiet window, then searches forward for a
   * responsiveness window, then searches backward for when the responsiveness window ends.
   *
   * @param {!Object} times
   * @param {!Object} timestamps
   * @param {!Object} data
   * @param {{allowedConcurrentRequests: number, responsivenessWindowSize: number, percentile: number,
   *    networkWindowSize: number}} options
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array,
   *    networkQuietPeriods: !Array}}
   */
  static _networkReverseSearch(times, timestamps, data, options) {
    const forwardSearchResult = TTIMetric._networkForwardSearch(times, timestamps, data, options);
    if (!forwardSearchResult.timeInMs) {
      return forwardSearchResult;
    }

    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      forwardSearchResult.timeInMs + 5000,
      data.model,
      data.trace,
      Object.assign({}, options, {isForwardSearch: false})
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlpha(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      // when screenshots are not available, visuallyReady is 0 and this falls back to fMP
      Math.max(times.firstMeaningfulPaint, times.visuallyReady),
      times.traceEnd,
      data.model,
      data.trace
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaFMPOnly(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaFMPOnly2s(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace,
      {responsivenessWindowSize: 2000}
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaFMPOnly5s(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace,
      {responsivenessWindowSize: 5000}
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaFMPOnly2sLongTask(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace,
      {responsivenessWindowSize: 2000, responsivenessPercentile: 'long-tasks'}
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaFMPOnly5sLongTask(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace,
      {responsivenessWindowSize: 5000, responsivenessPercentile: 'long-tasks'}
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * @param {{model: !Object, trace: !Object}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array}}
   */
  static findTTIAlphaPatrick(times, data) {
    return TTIMetric._slidingResponsivenessWindow(
      times.firstMeaningfulPaint,
      times.traceEnd,
      data.model,
      data.trace,
      {responsivenessWindowSize: 5000, responsivenessPercentile: 'patrick'}
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} timestamps
   * @param {{model: !Object, trace: !Object, networkRecords: !Array}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array,
   *    networkQuietPeriods: !Array}}
   */
  static findTTIAlphaNetworkReverseSearch(times, timestamps, data) {
    return TTIMetric._networkReverseSearch(
      times,
      timestamps,
      data,
      {
        allowedConcurrentRequests: 2,
        networkWindowSize: 0,
        responsivenessWindowSize: 5000,
        responsivenessPercentile: 'long-tasks',
      }
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} timestamps
   * @param {{model: !Object, trace: !Object, networkRecords: !Array}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array,
   *    networkQuietPeriods: !Array}}
   */
  static findTTIAlphaNetworkReverseSearchEIL(times, timestamps, data) {
    return TTIMetric._networkReverseSearch(
      times,
      timestamps,
      data,
      {
        allowedConcurrentRequests: 2,
        networkWindowSize: 0,
        responsivenessWindowSize: 5000,
        responsivenessPercentile: .9,
      }
    );
  }

  /**
   * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} times
   * * @param {{firstMeaningfulPaint: number, visuallyReady: number, traceEnd: number}} timestamps
   * @param {{model: !Object, trace: !Object, networkRecords: !Array}} data
   * @return {{timeInMs: number|undefined, currentLatency: number, foundLatencies: !Array,
   *    networkQuietPeriods: !Array}}
   */
  static findTTIAlphaCriticalNetworkForwardSearch(times, timestamps, data) {
    const scriptsOnly = data.networkRecords.filter(record => {
      return ['VeryHigh', 'High', 'Medium'].includes(record.priority()) &&
        record._resourceType !== 'xhr' && !/(image|audio|video)/.test(record._mimeType);
    });
    return TTIMetric._networkForwardSearch(
      times,
      timestamps,
      Object.assign({}, data, {networkRecords: scriptsOnly}),
      {
        allowedConcurrentRequests: 0,
        networkWindowSize: 500,
        responsivenessWindowSize: 2000,
        percentile: .95,
      }
    );
  }

  /**
   * Identify the time the page is "interactive"
   * @see https://docs.google.com/document/d/1oiy0_ych1v2ADhyG_QW7Ps4BNER2ShlJjx2zCbVzVyY/edit#
   *
   * The user thinks the page is ready - (They believe the page is done enough to start interacting with)
   *   - Layout has stabilized & key webfonts are visible.
   *     AKA: First meaningful paint has fired.
   *   - Page is nearly visually complete
   *     Visual completion is 85%
   *
   * The page is actually ready for user:
   *   - domContentLoadedEventEnd has fired
   *     Definition: HTML parsing has finished, all DOMContentLoaded handlers have run.
   *     No risk of DCL event handlers changing the page
   *     No surprises of inactive buttons/actions as DOM element event handlers should be bound
   *   - The main thread is available enough to handle user input
   *     first 500ms window where Est Input Latency is <50ms at the 90% percentile.
   *
   * WARNING: This metric WILL change its calculation. If you rely on its numbers now, know that they
   * will be changing in the future to a more accurate number.
   *
   * @param {!Artifacts} artifacts The artifacts from the gather phase.
   * @return {!Promise<!AuditResult>} The score from the audit, ranging from 0-100.
   */
  static audit(artifacts) {
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const networkRecords = artifacts.networkRecords[Audit.DEFAULT_PASS];

    let debugString;
    // We start looking at Math.Max(FMP, visProgress[0.85])
    const pending = [
      artifacts.requestSpeedline(trace).catch(err => {
        debugString = `Trace error: ${err.message}`;
        return null;
      }),
      artifacts.requestTraceOfTab(trace),
      artifacts.requestTracingModel(trace)
    ];
    return Promise.all(pending).then(([speedline, tabTrace, model]) => {
      // frame monotonic timestamps from speedline are in ms (ts / 1000), so we'll match
      //   https://github.com/pmdartus/speedline/blob/123f512632a/src/frame.js#L86
      const fMPtsInMS = tabTrace.timestamps.firstMeaningfulPaint;
      const navStartTsInMS = tabTrace.timestamps.navigationStart;

      if (!fMPtsInMS) {
        throw new Error('No firstMeaningfulPaint event found in trace');
      }

      const onLoadTiming = tabTrace.timings.onLoad;
      const fmpTiming = tabTrace.timings.firstMeaningfulPaint;
      const traceEndTiming = tabTrace.timings.traceEnd;

      // look at speedline results for 85% starting at FMP
      let visuallyReady = 0;
      if (speedline && speedline.frames) {
        const eightyFivePctVC = speedline.frames.find(frame => {
          return frame.getTimeStamp() >= fMPtsInMS && frame.getProgress() >= 85;
        });
        if (eightyFivePctVC) {
          visuallyReady = eightyFivePctVC.getTimeStamp() - navStartTsInMS;
        }
      }

      const timings = Object.assign({visuallyReady}, tabTrace.timings);
      const timestamps = Object.assign({}, tabTrace.timestamps);
      const data = {tabTrace, model, trace, networkRecords};
      const timeToInteractive = TTIMetric.findTTIAlpha(timings, data);
      const timeToInteractiveB = TTIMetric.findTTIAlphaFMPOnly(timings, data);
      const timeToInteractiveC = TTIMetric.findTTIAlphaFMPOnly5s(timings, data);
      const timeToInteractiveD = TTIMetric.findTTIAlphaFMPOnly2s(timings, data);
      const timeToInteractiveE = TTIMetric.findTTIAlphaNetworkReverseSearch(timings, timestamps,
          data);
      const timeToInteractiveF = TTIMetric.findTTIAlphaNetworkReverseSearchEIL(timings, timestamps,
          data);
      const timeToInteractiveG = TTIMetric.findTTIAlphaCriticalNetworkForwardSearch(timings, timestamps, data);
      const timeToInteractiveH = TTIMetric.findTTIAlphaFMPOnly5sLongTask(timings, data);
      const timeToInteractiveI = TTIMetric.findTTIAlphaFMPOnly2sLongTask(timings, data);
      const timeToInteractiveJ = TTIMetric.findTTIAlphaPatrick(timings, data);

      if (!timeToInteractive.timeInMs) {
        throw new Error('Entire trace was found to be busy.');
      }

      // Use the CDF of a log-normal distribution for scoring.
      //   < 1200ms: score≈100
      //   5000ms: score=50
      //   >= 15000ms: score≈0
      const distribution = TracingProcessor.getLogNormalDistribution(SCORING_MEDIAN,
          SCORING_POINT_OF_DIMINISHING_RETURNS);
      let score = 100 * distribution.computeComplementaryPercentile(timeToInteractive.timeInMs);

      // Clamp the score to 0 <= x <= 100.
      score = Math.min(100, score);
      score = Math.max(0, score);
      score = Math.round(score);

      const networkIdles = {
          network0Quiet: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 0, 0),
          network2Quiet: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 2, 0),
          networkIdle500ms: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 0, 500),
          network2Idle500ms: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 2, 500),
          networkIdle1s: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 0, 1000),
          networkIdle5s: TTIMetric._findNetworkNQuietStart(networkRecords, timestamps, 0, 3000),
      }

      const extendedInfo = {
        timings: {
          onLoad: onLoadTiming,
          fMP: parseFloat(timings.firstMeaningfulPaint.toFixed(3)),
          visuallyReady: parseFloat(visuallyReady.toFixed(3)),
          timeToInteractive: parseFloat(timeToInteractive.timeInMs.toFixed(3)),
          timeToInteractiveB: timeToInteractiveB.timeInMs,
          timeToInteractiveC: timeToInteractiveC.timeInMs,
          timeToInteractiveD: timeToInteractiveD.timeInMs,
          timeToInteractiveE: timeToInteractiveE.timeInMs,
          timeToInteractiveF: timeToInteractiveF.timeInMs,
          timeToInteractiveG: timeToInteractiveG.timeInMs,
          timeToInteractiveH: timeToInteractiveH.timeInMs,
          timeToInteractiveI: timeToInteractiveI.timeInMs,
          timeToInteractiveJ: timeToInteractiveJ.timeInMs,
          network0Quiet: networkIdles.network0Quiet.timing,
          network2Quiet: networkIdles.network2Quiet.timing,
          networkIdle500ms: networkIdles.networkIdle500ms.timing,
          network2Idle500ms: networkIdles.network2Idle500ms.timing,
          networkIdle1s: networkIdles.networkIdle1s.timing,
          networkIdle5s: networkIdles.networkIdle5s.timing,
          endOfTrace: timings.traceEnd,
        },
        timestamps: {
          onLoad: (onLoadTiming + navStartTsInMS) * 1000,
          fMP: fMPtsInMS * 1000,
          visuallyReady: (visuallyReady + navStartTsInMS) * 1000,
          timeToInteractive: (timeToInteractive.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveB: (timeToInteractiveB.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveC: (timeToInteractiveC.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveD: (timeToInteractiveD.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveE: (timeToInteractiveE.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveF: (timeToInteractiveF.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveG: (timeToInteractiveG.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveH: (timeToInteractiveH.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveI: (timeToInteractiveI.timeInMs + navStartTsInMS) * 1000,
          timeToInteractiveJ: (timeToInteractiveJ.timeInMs + navStartTsInMS) * 1000,
          network0Quiet: networkIdles.network0Quiet.start,
          network2Quiet: networkIdles.network2Quiet.start,
          networkIdle500ms: networkIdles.networkIdle500ms.start,
          network2Idle500ms: networkIdles.network2Idle500ms.start,
          networkIdle1s: networkIdles.networkIdle1s.start,
          networkIdle5s: networkIdles.networkIdle5s.start,
          load: timestamps.load * 1000,
          domContentLoaded: timestamps.domContentLoaded * 1000,
          endOfTrace: timestamps.traceEnd * 1000,
        },
        latencies: {
          timeToInteractive: timeToInteractive.foundLatencies,
          timeToInteractiveB: timeToInteractiveB.foundLatencies,
          timeToInteractiveC: timeToInteractiveC.foundLatencies,
          timeToInteractiveD: timeToInteractiveD.foundLatencies,
          timeToInteractiveE: timeToInteractiveE.foundLatencies,
        },
        networkQuietPeriods: {
          timeToInteractiveD: timeToInteractiveD.networkQuietPeriods,
          timeToInteractiveE: timeToInteractiveE.networkQuietPeriods,
        },
        expectedLatencyAtTTI: parseFloat(timeToInteractive.currentLatency.toFixed(3))
      };

      return {
        score,
        debugString,
        rawValue: parseFloat(timeToInteractive.timeInMs.toFixed(1)),
        displayValue: `${parseFloat(timeToInteractive.timeInMs.toFixed(1))}ms`,
        optimalValue: this.meta.optimalValue,
        extendedInfo: {
          value: extendedInfo,
          formatter: Formatter.SUPPORTED_FORMATS.NULL
        }
      };
    });
  }
}

module.exports = TTIMetric;
