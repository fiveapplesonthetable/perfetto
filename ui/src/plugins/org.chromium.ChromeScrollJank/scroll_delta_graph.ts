// Copyright (C) 2023 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {type duration, Time, type time} from '../../base/time';
import type {Engine} from '../../trace_processor/engine';
import {LONG, NUM} from '../../trace_processor/query_result';
import {
  Scatterplot,
  type ScatterChartSeries,
} from '../../components/widgets/charts/scatterplot';

const INPUT_CATEGORY = 'Input';
const PRESENTED_CATEGORY = 'Presented';
const PRESENTED_JANKY_CATEGORY = 'Presented with Predictor Jank';

interface ScrollDeltaPlotDatum {
  // What type of data this is - input scroll or presented scroll. This is used
  // to denote the color of the data point.
  category: string;
  offset: number;
  scrollUpdateId: number;
  ts: number;
  delta: number;
  predictorJank: string;
}

export interface ScrollDeltaDetails {
  ts: time;
  scrollUpdateId: number;
  scrollDelta: number;
  scrollOffset: number;
  predictorJank: number;
}

export interface JankIntervalPlotDetails {
  start_ts: number;
  end_ts: number;
}

export async function getInputScrollDeltas(
  engine: Engine,
  scrollId: bigint,
): Promise<ScrollDeltaDetails[]> {
  const queryResult = await engine.query(`
    INCLUDE PERFETTO MODULE chrome.scroll_jank.scroll_offsets;

    SELECT
      ts,
      IFNULL(scroll_update_id, 0) AS scrollUpdateId,
      delta_y AS deltaY,
      relative_offset_y AS offsetY
    FROM chrome_scroll_input_offsets
    WHERE scroll_id = ${scrollId};
  `);

  const it = queryResult.iter({
    ts: LONG,
    scrollUpdateId: NUM,
    deltaY: NUM,
    offsetY: NUM,
  });
  const deltas: ScrollDeltaDetails[] = [];

  for (; it.valid(); it.next()) {
    deltas.push({
      ts: Time.fromRaw(it.ts),
      scrollUpdateId: it.scrollUpdateId,
      scrollOffset: it.offsetY,
      scrollDelta: it.deltaY,
      predictorJank: 0,
    });
  }

  return deltas;
}

export async function getPresentedScrollDeltas(
  engine: Engine,
  scrollId: bigint,
): Promise<ScrollDeltaDetails[]> {
  const queryResult = await engine.query(`
    INCLUDE PERFETTO MODULE chrome.scroll_jank.scroll_offsets;

    SELECT
      ts,
      IFNULL(scroll_update_id, 0) AS scrollUpdateId,
      delta_y AS deltaY,
      relative_offset_y AS offsetY
    FROM chrome_presented_scroll_offsets
    WHERE scroll_id = ${scrollId}
      -- Filter out the deltas which do not have a presented timestamp.
      -- This is needed for now as we don't perfectly all EventLatencies to
      -- presentation, e.g. for dropped frames (crbug.com/380286381).
      AND ts IS NOT NULL
      AND delta_y IS NOT NULL;
  `);

  const it = queryResult.iter({
    ts: LONG,
    scrollUpdateId: NUM,
    deltaY: NUM,
    offsetY: NUM,
  });
  const deltas: ScrollDeltaDetails[] = [];
  let offset = 0;

  for (; it.valid(); it.next()) {
    offset = it.offsetY;

    deltas.push({
      ts: Time.fromRaw(it.ts),
      scrollUpdateId: it.scrollUpdateId,
      scrollOffset: offset,
      scrollDelta: it.deltaY,
      predictorJank: 0,
    });
  }

  return deltas;
}

export async function getPredictorJankDeltas(
  engine: Engine,
  scrollId: bigint,
): Promise<ScrollDeltaDetails[]> {
  const queryResult = await engine.query(`
    INCLUDE PERFETTO MODULE chrome.scroll_jank.predictor_error;

    SELECT
      present_ts AS ts,
      IFNULL(scroll_update_id, 0) AS scrollUpdateId,
      delta_y AS deltaY,
      relative_offset_y AS offsetY,
      predictor_jank AS predictorJank
    FROM chrome_predictor_error
    WHERE scroll_id = ${scrollId}
      AND predictor_jank != 0 AND predictor_jank IS NOT NULL;
  `);

  const it = queryResult.iter({
    ts: LONG,
    scrollUpdateId: NUM,
    deltaY: NUM,
    offsetY: NUM,
    predictorJank: NUM,
  });
  const deltas: ScrollDeltaDetails[] = [];
  let offset = 0;

  for (; it.valid(); it.next()) {
    offset = it.offsetY;

    deltas.push({
      ts: Time.fromRaw(it.ts),
      scrollUpdateId: it.scrollUpdateId,
      scrollOffset: offset,
      scrollDelta: it.deltaY,
      predictorJank: it.predictorJank,
    });
  }

  return deltas;
}

export async function getJankIntervals(
  engine: Engine,
  startTs: time,
  dur: duration,
): Promise<JankIntervalPlotDetails[]> {
  const queryResult = await engine.query(`
    INCLUDE PERFETTO MODULE chrome.scroll_jank.scroll_jank_intervals;

    SELECT
      ts,
      dur
    FROM chrome_janky_frame_presentation_intervals
    WHERE ts >= ${startTs} AND ts <= ${startTs + dur};
  `);

  const it = queryResult.iter({
    ts: LONG,
    dur: LONG,
  });

  const details: JankIntervalPlotDetails[] = [];

  for (; it.valid(); it.next()) {
    details.push({
      start_ts: Number(it.ts),
      end_ts: Number(it.ts + it.dur),
    });
  }

  return details;
}

// TODO(b/352038635): Show the error margin on the graph - what the pixel offset
// should have been if there were no predictor jank.
export function buildScrollOffsetsGraph(
  inputDeltas: ScrollDeltaDetails[],
  presentedDeltas: ScrollDeltaDetails[],
  predictorDeltas: ScrollDeltaDetails[],
  jankIntervals: JankIntervalPlotDetails[],
): m.Child {
  const inputData = buildOffsetData(inputDeltas, INPUT_CATEGORY);
  // Filter out the predictor deltas from the presented deltas, as these will be
  // rendered in a new layer, with new tooltip/color/etc.
  const filteredPresentedDeltas = presentedDeltas.filter((item) => {
    for (let i = 0; i < predictorDeltas.length; i++) {
      const predictorDelta: ScrollDeltaDetails = predictorDeltas[i];
      if (
        predictorDelta.ts == item.ts &&
        predictorDelta.scrollUpdateId == item.scrollUpdateId
      ) {
        return false;
      }
    }
    return true;
  });

  const presentedData = buildOffsetData(
    filteredPresentedDeltas,
    PRESENTED_CATEGORY,
  );
  const predictorData = buildOffsetData(
    predictorDeltas,
    PRESENTED_JANKY_CATEGORY,
  );

  const toPoints = (data: ScrollDeltaPlotDatum[]) =>
    data.map((d) => ({
      x: d.ts,
      y: d.offset,
      label:
        `Delta: ${d.delta.toFixed(2)}, Trace Id: ${d.scrollUpdateId}` +
        (d.predictorJank !== 'N/A'
          ? `, Predictor Jank: ${d.predictorJank}`
          : ''),
    }));
  const series: ScatterChartSeries[] = [];
  if (inputData.length > 0) {
    series.push({name: INPUT_CATEGORY, points: toPoints(inputData)});
  }
  if (presentedData.length > 0) {
    series.push({name: PRESENTED_CATEGORY, points: toPoints(presentedData)});
  }
  if (predictorData.length > 0) {
    series.push({
      name: PRESENTED_JANKY_CATEGORY,
      points: toPoints(predictorData),
    });
  }

  return m(Scatterplot, {
    data: {series},
    height: 300,
    xAxisLabel: 'Raw Timestamp',
    yAxisLabel: 'Offset (pixels)',
    showLegend: true,
    scaleAxes: true,
    // Shade the jank intervals behind the points (start_ts/end_ts are in ns;
    // the point timestamps use the same /10e8 conversion).
    highlightBands: jankIntervals.map((j) => ({
      start: j.start_ts / 10e8,
      end: j.end_ts / 10e8,
    })),
  });
}

function buildOffsetData(
  deltas: ScrollDeltaDetails[],
  category: string,
): ScrollDeltaPlotDatum[] {
  const plotData: ScrollDeltaPlotDatum[] = [];
  for (const delta of deltas) {
    let predictorJank = 'N/A';
    if (delta.predictorJank > 0) {
      predictorJank = parseFloat(delta.predictorJank.toString()).toFixed(2);
      predictorJank +=
        " (times delta compared to the next/previous frame's delta)";
    }
    plotData.push({
      category: category,
      ts: Number(delta.ts) / 10e8,
      scrollUpdateId: delta.scrollUpdateId,
      offset: delta.scrollOffset,
      delta: delta.scrollDelta,
      predictorJank: predictorJank,
    });
  }

  return plotData;
}
