import { MP4Info, MP4Sample } from '@webav/mp4box.js';
import {
  autoReadStream,
  concatPCMFragments,
  createAudioChunksDecoder,
  sleep,
} from '../av-utils';
import { Log } from '../log';
import { extractFileConfig, sample2ChunkOpts } from '../mp4-utils/mp4box-utils';
import { SampleTransform } from '../mp4-utils/sample-transform';
import { DEFAULT_AUDIO_CONF, IClip } from './iclip';

let CLIP_ID = 0;

type MPClipCloneArgs = Omit<
  Awaited<ReturnType<typeof parseMP4Stream>>,
  'videoTicker'
>;
export class MP4Clip implements IClip {
  #log = Log.create(`MP4Clip id:${CLIP_ID++},`);

  ready: IClip['ready'];

  #destroyed = false;

  #meta = {
    // 微秒
    duration: 0,
    width: 0,
    height: 0,
    audioSampleRate: DEFAULT_AUDIO_CONF.sampleRate,
    audioChanCount: DEFAULT_AUDIO_CONF.channelCount,
  };

  get meta() {
    return this.#meta;
  }

  #volume = 1;

  #videoSamples: Array<MP4Sample & { deleted?: boolean }> = [];

  #audioSamples: Array<MP4Sample & { deleted?: boolean }> = [];

  #audioChunksDec: ReturnType<typeof createAudioChunksDecoder> | null = null;
  #videoTicker: VideoFrameTicker | null = null;

  #decoderConf: {
    video: VideoDecoderConfig | null;
    audio: AudioDecoderConfig | null;
  } = {
    video: null,
    audio: null,
  };

  #opts: {
    audio?: boolean | { volume: number };
  } = { audio: false };

  constructor(
    source: ReadableStream<Uint8Array> | MPClipCloneArgs,
    opts: {
      audio?: boolean | { volume: number };
    } = {},
  ) {
    this.#opts = { ...opts };
    this.#volume =
      typeof opts.audio === 'object' && 'volume' in opts.audio
        ? opts.audio.volume
        : 1;

    if (source instanceof ReadableStream) {
      this.ready = parseMP4Stream(source, this.#opts).then(
        ({
          audioChunksDec,
          videoSamples,
          audioSamples,
          videoTicker,
          decoderConf,
          meta,
        }) => {
          this.#audioChunksDec = audioChunksDec;
          this.#videoSamples = videoSamples;
          this.#audioSamples = audioSamples;
          this.#decoderConf = decoderConf;
          this.#videoTicker = videoTicker;
          this.#meta = meta;
          return meta;
        },
      );
    } else {
      this.#audioChunksDec = source.audioChunksDec;
      this.#videoSamples = source.videoSamples;
      this.#audioSamples = source.audioSamples;
      this.#decoderConf = source.decoderConf;
      this.#videoTicker = new VideoFrameTicker(
        source.videoSamples,
        source.decoderConf.video!,
      );
      this.#meta = source.meta;
      this.ready = Promise.resolve(this.meta);
    }
  }

  #pcmData: [Float32Array, Float32Array] = [
    new Float32Array(0), // left chan
    new Float32Array(0), // right chan
  ];
  #audioDecCusorIdx = 0;
  #audioDecoding = false;
  async #nextAudio(deltaTime: number): Promise<Float32Array[]> {
    const frameCnt = Math.ceil(deltaTime * (this.#meta.audioSampleRate / 1e6));
    if (this.#audioChunksDec == null || this.#destroyed || frameCnt === 0) {
      return [];
    }

    // 数据满足需要
    if (this.#pcmData[0].length > frameCnt) {
      const audio = [
        this.#pcmData[0].slice(0, frameCnt),
        this.#pcmData[1].slice(0, frameCnt),
      ];
      this.#pcmData[0] = this.#pcmData[0].slice(frameCnt);
      this.#pcmData[1] = this.#pcmData[1].slice(frameCnt);
      return audio;
    }

    if (this.#audioDecoding) {
      // 解码中，等待
      await sleep(15);
    } else if (this.#audioDecCusorIdx >= this.#audioSamples.length - 1) {
      // decode completed
      return [];
    } else {
      // 启动解码任务
      const samples = [];
      for (let i = this.#audioDecCusorIdx; i < this.#audioSamples.length; i++) {
        this.#audioDecCusorIdx = i;
        const s = this.#audioSamples[i];
        if (s.deleted) continue;
        if (samples.length > 10) break;
        samples.push(s);
      }

      this.#audioDecoding = true;
      this.#audioChunksDec.decode(
        samples.map((s) => new EncodedAudioChunk(sample2ChunkOpts(s))),
        (pcmArr, done) => {
          if (pcmArr.length === 0) return;
          // 音量调节
          if (this.#volume !== 1) {
            for (const pcm of pcmArr)
              for (let i = 0; i < pcm.length; i++) pcm[i] *= this.#volume;
          }
          // 补齐双声道
          if (pcmArr.length === 1) pcmArr = [pcmArr[0], pcmArr[0]];

          this.#pcmData = concatPCMFragments([this.#pcmData, pcmArr]) as [
            Float32Array,
            Float32Array,
          ];
          if (done) this.#audioDecoding = false;
        },
      );
    }
    return this.#nextAudio(deltaTime);
  }

  // 默认直接返回
  tickInterceptor = async (_: number, tickRet: any) => tickRet;

  #ts = 0;
  async tick(time: number): Promise<{
    video?: VideoFrame;
    audio: Float32Array[];
    state: 'success' | 'done';
  }> {
    if (time >= this.#meta.duration) {
      return await this.tickInterceptor(time, {
        audio: [],
        state: 'done',
      });
    }

    const [audio, video] = await Promise.all([
      this.#nextAudio(time - this.#ts),
      this.#videoTicker?.tick(time),
    ]);
    this.#ts = time;
    if (video == null) {
      return await this.tickInterceptor(time, {
        audio,
        state: 'success',
      });
    }

    return await this.tickInterceptor(time, {
      video,
      audio,
      state: 'success',
    });
  }

  deleteRange(startTime: number, endTime: number) {
    if (endTime <= startTime)
      throw Error('endTime must be greater than startTime');

    _del(this.#videoSamples, startTime, endTime);
    _del(this.#audioSamples, startTime, endTime);
    this.#meta.duration -= endTime - startTime;
    for (let i = this.#videoSamples.length - 1; i >= 0; i--) {
      const s = this.#videoSamples[i];
      if (s.deleted) continue;
      this.#meta.duration = s.cts + s.duration;
      break;
    }

    function _del(
      samples: Array<MP4Sample & { deleted?: boolean }>,
      startTime: number,
      endTime: number,
    ) {
      for (const s of samples) {
        if (s.deleted) continue;

        if (s.cts >= startTime && s.cts <= endTime) {
          s.deleted = true;
          s.cts = -1;
        } else if (s.cts > endTime) {
          s.cts -= endTime - startTime;
        }
      }
    }
  }

  thumbnails(): Promise<Array<{ ts: number; img: Blob }>> {
    const vc = this.#decoderConf.video;
    if (vc == null) return Promise.resolve([]);

    const { width, height } = this.#meta;
    const convtr = createVF2BlobConvtr(
      100,
      Math.round(height * (100 / width)),
      { quality: 0.1, type: 'image/png' },
    );

    return new Promise<Array<{ ts: number; img: Blob }>>(async (resolve) => {
      const pngPromises: Array<{ ts: number; img: Promise<Blob> }> = [];
      async function resolver() {
        resolve(
          await Promise.all(
            pngPromises.map(async (it) => ({
              ts: it.ts,
              img: await it.img,
            })),
          ),
        );
      }

      const samples = this.#videoSamples
        .filter((s) => !s.deleted && s.is_sync)
        .map(sample2VideoChunk);
      if (samples.length === 0) {
        resolver();
        return;
      }

      let cnt = 0;
      const dec = new VideoDecoder({
        output: (vf) => {
          cnt += 1;
          pngPromises.push({
            ts: vf.timestamp,
            img: convtr(vf),
          });
          if (cnt === samples.length) resolver();
        },
        error: Log.error,
      });
      dec.configure(vc);
      samples.forEach((c) => {
        dec.decode(c);
      });
      await dec.flush();
    });
  }

  async clone() {
    await this.ready;
    const videoSamples = [...this.#videoSamples];
    const clip = new MP4Clip(
      {
        audioChunksDec: this.#audioChunksDec,
        videoSamples: videoSamples,
        audioSamples: [...this.#audioSamples],
        decoderConf: this.#decoderConf,
        meta: { ...this.#meta },
      },
      this.#opts,
    );
    await clip.ready;
    clip.tickInterceptor = this.tickInterceptor;
    return clip as this;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#log.info('MP4Clip destroy, ts:', this.#ts);
    this.#destroyed = true;

    this.#videoTicker?.destroy();
  }
}

async function parseMP4Stream(
  source: ReadableStream<Uint8Array>,
  opts: {
    audio?: boolean | { volume: number };
  } = {},
) {
  let mp4Info: MP4Info;
  const decoderConf: {
    video: VideoDecoderConfig | null;
    audio: AudioDecoderConfig | null;
  } = { video: null, audio: null };
  let audioChunksDec: ReturnType<typeof createAudioChunksDecoder> | null = null;
  let videoSamples: Array<MP4Sample & { deleted?: boolean }> = [];
  let audioSamples: Array<MP4Sample & { deleted?: boolean }> = [];
  let meta = {
    // 微秒
    duration: 0,
    width: 0,
    height: 0,
    audioSampleRate: DEFAULT_AUDIO_CONF.sampleRate,
    audioChanCount: DEFAULT_AUDIO_CONF.channelCount,
  };
  return new Promise<{
    audioChunksDec: ReturnType<typeof createAudioChunksDecoder> | null;
    videoSamples: typeof videoSamples;
    audioSamples: typeof audioSamples;
    videoTicker: VideoFrameTicker;
    decoderConf: typeof decoderConf;
    meta: typeof meta;
  }>(async (resolve, reject) => {
    const stopRead = autoReadStream(source.pipeThrough(new SampleTransform()), {
      onChunk: async ({ chunkType, data }) => {
        if (chunkType === 'ready') {
          Log.info('mp4BoxFile is ready', data);
          // mp4File = data.file;
          mp4Info = data.info;
          let { videoDecoderConf: vc, audioDecoderConf: ac } =
            extractFileConfig(data.file, data.info);
          decoderConf.video = vc ?? null;
          decoderConf.audio = ac ?? null;
          if (vc == null) {
            stopRead();
            reject(
              Error(
                'MP4 file does not include a video track or uses an unsupported codec',
              ),
            );
          }
          if (opts.audio && decoderConf.audio != null) {
            audioChunksDec = createAudioChunksDecoder(
              decoderConf.audio,
              DEFAULT_AUDIO_CONF.sampleRate,
            );
          }
        } else if (chunkType === 'samples') {
          if (data.type === 'video') {
            videoSamples = videoSamples.concat(
              data.samples.map((s) => ({
                ...s,
                cts: (s.cts / s.timescale) * 1e6,
                dts: (s.dts / s.timescale) * 1e6,
                duration: (s.duration / s.timescale) * 1e6,
                timescale: 1e6,
              })),
            );
          } else if (data.type === 'audio') {
            audioSamples = audioSamples.concat(
              data.samples.map((s) => ({
                ...s,
                cts: (s.cts / s.timescale) * 1e6,
                dts: (s.dts / s.timescale) * 1e6,
                duration: (s.duration / s.timescale) * 1e6,
                timescale: 1e6,
              })),
            );
          }
        }
      },
      onDone: () => {
        const lastSampele = videoSamples.at(-1);
        if (
          mp4Info == null ||
          lastSampele == null ||
          decoderConf.video == null
        ) {
          reject(Error('MP4Clip stream is done, but not emit ready'));
          return;
        }
        const videoTrack = mp4Info.videoTracks[0];
        const width = videoTrack.track_width;
        const height = videoTrack.track_height;
        const duration = lastSampele.cts + lastSampele.duration;
        meta = {
          duration,
          width,
          height,
          audioSampleRate: DEFAULT_AUDIO_CONF.sampleRate,
          audioChanCount: DEFAULT_AUDIO_CONF.channelCount,
        };
        resolve({
          audioChunksDec,
          videoSamples,
          audioSamples,
          videoTicker: new VideoFrameTicker(videoSamples, decoderConf.video),
          decoderConf,
          meta,
        });
      },
    });
  });
}

class VideoFrameTicker {
  #dec!: VideoDecoder;
  constructor(
    public samples: Array<MP4Sample & { deleted?: boolean }>,
    public conf: VideoDecoderConfig,
  ) {
    this.#reset();
  }

  #ts = 0;
  #videoDecCusorIdx = 0;
  #videoFrames: VideoFrame[] = [];
  #outputFrameCnt = 0;
  #inputChunkCnt = 0;
  #parseFrame = async (
    time: number,
    dec: VideoDecoder,
    aborter: { abort: boolean },
  ): Promise<VideoFrame | null> => {
    if (dec.state === 'closed' || aborter.abort) return null;

    if (this.#videoFrames.length > 0) {
      const vf = this.#videoFrames[0];
      if (time < vf.timestamp) return null;
      // 弹出第一帧
      this.#videoFrames.shift();
      // 第一帧过期，找下一帧
      if (time > vf.timestamp + (vf.duration ?? 0)) {
        vf.close();
        return this.#parseFrame(time, dec, aborter);
      }
      // 符合期望
      return vf;
    }

    // 缺少帧数据
    if (this.#outputFrameCnt < this.#inputChunkCnt) {
      // 解码中，等待，然后重试
      await sleep(15);
    } else if (this.#videoDecCusorIdx >= this.samples.length) {
      // decode completed
      return null;
    } else {
      // 启动解码任务，然后重试
      let endIdx = this.#videoDecCusorIdx + 1;
      // 该 GoP 时间区间有时间匹配，且未被删除的帧
      let hasValidFrame = false;
      for (; endIdx < this.samples.length; endIdx++) {
        const s = this.samples[endIdx];
        if (!hasValidFrame && !s.deleted && time < s.cts + s.duration) {
          hasValidFrame = true;
        }
        // 找一个 GoP，所以是下一个关键帧结束
        if (s.is_sync) break;
      }

      if (hasValidFrame) {
        const chunks = this.samples
          .slice(this.#videoDecCusorIdx, endIdx)
          .map(sample2VideoChunk);
        this.#inputChunkCnt += chunks.length;
        chunks.forEach((c) => {
          dec.decode(c);
        });
        dec.flush().catch(Log.error);
      }
      this.#videoDecCusorIdx = endIdx;
    }
    return this.#parseFrame(time, dec, aborter);
  };

  #destroyed = false;
  #curAborter = { abort: false };
  tick = async (time: number): Promise<VideoFrame | null> => {
    if (this.#destroyed) return null;
    if (time <= this.#ts || time - this.#ts > 3e6) {
      this.#reset();
    }

    this.#curAborter.abort = true;
    this.#ts = time;

    return new Promise(async (reslove) => {
      this.#curAborter = { abort: false };
      reslove(await this.#parseFrame(time, this.#dec, this.#curAborter));
    });
  };

  #reset = () => {
    this.#videoFrames.forEach((f) => f.close());
    this.#videoFrames = [];
    this.#videoDecCusorIdx = 0;
    this.#inputChunkCnt = 0;
    this.#outputFrameCnt = 0;
    try {
      this.#dec?.close();
    } catch (error) {
      Log.error(error);
    }
    this.#dec = new VideoDecoder({
      output: (vf) => {
        this.#outputFrameCnt += 1;
        this.#videoFrames.push(vf);
      },
      error: Log.error,
    });
    this.#dec.configure(this.conf);
  };

  destroy = () => {
    this.#destroyed = true;
    this.#curAborter.abort = true;
    this.#videoFrames.forEach((f) => f.close());
    this.#videoFrames = [];
  };
}

function sample2VideoChunk(s: MP4Sample) {
  return new EncodedVideoChunk(sample2ChunkOpts(s));
}

function createVF2BlobConvtr(
  width: number,
  height: number,
  opts?: ImageEncodeOptions,
) {
  const cvs = new OffscreenCanvas(width, height);
  const ctx = cvs.getContext('2d')!;

  return async (vf: VideoFrame) => {
    ctx.drawImage(vf, 0, 0, width, height);
    vf.close();
    const blob = await cvs.convertToBlob(opts);
    return blob;
  };
}
