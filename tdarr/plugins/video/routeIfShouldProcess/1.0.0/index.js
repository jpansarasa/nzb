const details = () => ({
  name: 'Route If Should Process',
  description: `Checks ffmpegCommand.shouldProcess after "Check And Fix Incompatible Playback". A file
                with no VC-1/AV1/VP9 video or TrueHD audio streams leaves shouldProcess unset, so this
                routes it past Execute and Replace Original File instead of running it through a no-op
                remux-and-swap. Must run after "Check And Fix Incompatible Playback" and before
                "Execute".`,
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
      tooltip: 'Needs processing - continue to Execute',
    },
    {
      number: 2,
      tooltip: 'No problem streams found - skip Execute and Replace Original File',
    },
  ],
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (args) => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const shouldProcess = !!(args.variables.ffmpegCommand && args.variables.ffmpegCommand.shouldProcess);

  if (!shouldProcess) {
    args.jobLog('No VC-1/AV1/VP9/TrueHD streams found, nothing to fix - skipping Execute and Replace Original File.');
  }

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: shouldProcess ? 1 : 2,
    variables: args.variables,
  };
};

module.exports.details = details;
module.exports.plugin = plugin;
