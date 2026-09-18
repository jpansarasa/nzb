/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = () => ({
  name: 'Check And Fix Incompatible Playback',
  description: `Marks VC-1/AV1/VP9 video streams for re-encode to H.264, and TrueHD/Atmos audio
                streams for re-encode to EAC3 (640k). Every other stream is left as-is (Execute
                defaults untouched streams to stream copy). Must run after "Begin Command" and
                before "Execute".`,
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (args) => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const PROBLEM_VIDEO_CODECS = ['vc1', 'av1', 'vp9'];
  const streams = (args.variables.ffmpegCommand && args.variables.ffmpegCommand.streams) || [];

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
