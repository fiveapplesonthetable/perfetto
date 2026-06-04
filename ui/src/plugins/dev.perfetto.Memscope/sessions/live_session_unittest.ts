// Copyright (C) 2026 The Android Open Source Project
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

import protos from '../../../protos';
import {createMonitoringConfig} from './live_session';

describe('Memscope createMonitoringConfig', () => {
  test('omits display video by default', () => {
    const cfg = createMonitoringConfig('s', false);
    expect(cfg.buffers?.some((b) => b.name === 'video')).toBe(false);
    expect(
      cfg.dataSources?.some((d) => d.config?.name === 'android.display.video'),
    ).toBe(false);
  });

  test('adds a dedicated video buffer + data source when captureVideo', () => {
    const cfg = createMonitoringConfig('s', true);

    const videoBuf = cfg.buffers?.find((b) => b.name === 'video');
    expect(videoBuf).toBeDefined();
    expect(videoBuf!.fillPolicy).toBe(
      protos.TraceConfig.BufferConfig.FillPolicy.RING_BUFFER,
    );

    const videoDs = cfg.dataSources?.find(
      (d) => d.config?.name === 'android.display.video',
    );
    expect(videoDs).toBeDefined();
    // Targets its own buffer, so video never evicts memory data.
    expect(videoDs!.config?.targetBufferName).toBe('video');
    expect(videoDs!.config?.displayVideoConfig?.format).toBe(
      protos.DisplayVideoConfig.Format.FORMAT_H264,
    );
    // The cap bounds the buffer.
    expect(videoDs!.config?.displayVideoConfig?.maxStreamSizeBytes).toBe(
      videoBuf!.sizeKb! * 1024,
    );
  });

  test('does not disturb the existing memory data sources', () => {
    const base = createMonitoringConfig('s', false);
    const withVideo = createMonitoringConfig('s', true);
    // Every data source present without video is still present with it, in
    // the same order (video is strictly appended).
    const baseNames = base.dataSources?.map((d) => d.config?.name);
    const withNames = withVideo.dataSources?.map((d) => d.config?.name);
    expect(withNames?.slice(0, baseNames?.length)).toEqual(baseNames);
    expect(withNames?.[withNames.length - 1]).toBe('android.display.video');

    // The config is wire-valid: encode + decode round-trips and preserves
    // the video data source.
    const enc = protos.TraceConfig.encode(
      protos.TraceConfig.create(withVideo),
    ).finish();
    const dec = protos.TraceConfig.decode(enc);
    expect(
      dec.dataSources.some((d) => d.config?.name === 'android.display.video'),
    ).toBe(true);
  });
});
