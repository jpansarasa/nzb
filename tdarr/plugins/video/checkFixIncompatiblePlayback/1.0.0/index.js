/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = () => ({
  name: 'Check And Fix Incompatible Playback',
  description: `Marks VC-1/AV1/VP9 video streams for re-encode to H.264, Dolby Vision Profile 5
                video for conversion to HDR10 HEVC, and TrueHD/Atmos audio streams for re-encode
                to EAC3 (640k). Every other stream is left as-is (Execute defaults untouched
                streams to stream copy). Must run after "Begin Command" and before "Execute".`,
  style: {
    borderColor: '#6efefc',
  },
  tags: 'video',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.11.01',
  sidebarPosition: -1,
  icon: '',
  inputs: [],
  outputs: [
    {
      number: 1,
      tooltip: 'Continue to next plugin',
    },
  ],
});

// Profile 5 has no HDR10 base layer: the picture is stored in Dolby's IPTPQc2
// colour space, so anything short of a full DV pipeline (client, TV, any AVR
// between them) shows purple/green, and Plex's transcoder can't tone-map it.
// Other profiles (7, 8.x) carry an HDR10-compatible base layer and play fine.
const isDolbyVisionProfile5 = (stream) => (stream.side_data_list || []).some(
  (sd) => sd.side_data_type === 'DOVI configuration record' && Number(sd.dv_profile) === 5,
);

// libplacebo applies the DV RPU reshaping and converts to BT.2020/PQ on the
// iGPU via Vulkan; hevc_qsv encodes on the same iGPU. Decode stays on the CPU:
// the P630 (gen9) has no Vulkan video decode. Bitrate is explicit because
// hevc_qsv's ICQ mode undershoots badly on this content (~3 Mbps at 4K).
const DV5_FILTER = 'hwupload,'
  + 'libplacebo=apply_dolbyvision=1:colorspace=bt2020nc:color_primaries=bt2020'
  + ':color_trc=smpte2084:format=p010le,'
  + 'hwdownload,format=p010le';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (args) => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const PROBLEM_VIDEO_CODECS = ['vc1', 'av1', 'vp9'];
  const streams = (args.variables.ffmpegCommand && args.variables.ffmpegCommand.streams) || [];
  let vulkanDeviceAdded = false;

  for (let i = 0; i < streams.length; i += 1) {
    const stream = streams[i];
    if (stream.removed) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (stream.codec_type === 'video' && PROBLEM_VIDEO_CODECS.includes(stream.codec_name)) {
      stream.outputArgs.push(
        '-c:{outputIndex}', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
      );
      args.variables.ffmpegCommand.shouldProcess = true;
      // The source container may not support h264 (e.g. webm only allows
      // vp8/vp9/av1), so force mkv whenever we're changing the video codec.
      args.variables.ffmpegCommand.container = 'mkv';
      args.jobLog(`Video stream ${i} is ${stream.codec_name}, marking for re-encode to libx264 (container -> mkv).`);
    } else if (stream.codec_type === 'video' && isDolbyVisionProfile5(stream)) {
      // Execute prepends every stream's inputArgs before -i, so the device
      // must only be declared once even if a file had two such streams.
      if (!vulkanDeviceAdded) {
        stream.inputArgs.push('-init_hw_device', 'vulkan=vk:0', '-filter_hw_device', 'vk');
        vulkanDeviceAdded = true;
      }
      stream.outputArgs.push(
        '-filter:{outputIndex}', DV5_FILTER,
        '-c:{outputIndex}', 'hevc_qsv',
        '-profile:{outputIndex}', 'main10',
        '-b:{outputIndex}', '18M',
        '-maxrate:{outputIndex}', '30M',
        '-bufsize:{outputIndex}', '36M',
      );
      args.variables.ffmpegCommand.shouldProcess = true;
      args.jobLog(`Video stream ${i} is Dolby Vision Profile 5 (no HDR10 fallback), marking for conversion to HDR10 HEVC.`);
    }
    if (stream.codec_type === 'audio' && stream.codec_name === 'truehd') {
      stream.outputArgs.push(
        '-c:{outputIndex}', 'eac3',
        '-b:{outputIndex}', '640k',
      );
      args.variables.ffmpegCommand.shouldProcess = true;
      args.jobLog(`Audio stream ${i} is truehd, marking for re-encode to eac3.`);
    }
  }

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 1,
    variables: args.variables,
  };
};

module.exports.details = details;
module.exports.plugin = plugin;
