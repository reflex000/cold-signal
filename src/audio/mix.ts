// The mix: one level per sound, in dB, relative to how its builder writes it. The engine applies
// it to every voice it starts (one-shots by name, footsteps as 'step_<surface>', loops by name).
//
// Set by measuring each dry voice (tools/audio-check.mjs --dry 1, the "raw" column) against these
// targets for its peak at the reference distance, in dBFS:
//   interface -27..-17 (hover quietest)        own breath -30 (warm) .. -24 (freezing)
//   footsteps -17..-15                         body: hurt -14, downed / death -11, small -21..-16
//   small tools -24..-15, impacts -10..-7      rifle -1: the loudest thing in the game
//   wolves near -12..-8                        ice cracks -5, booms and thunder -8..-7
// and loops by their RMS: fire -28 (heat 1), stove -30, generator -24, radio -26, wolf breath -28.
// The master compressor starts at -12 dBFS, so everything but the shot and the big impacts passes
// it untouched and keeps its dynamics.
export const MIX: Readonly<Record<string, number>> = {
  // interface
  ui_hover: -8, ui_click: -3, ui_open: 0, ui_close: -5, toast: -1, objective: 0, part_found: 0,
  // body
  jump: 0, land: -3, hurt: 0, bite: -3.5, downed: -5, revived: -1, death: -5, shiver: -6, gasp: -3,
  cough: -4, eat: -4, drink: -6, bandage: -7, heartbeat: -12,
  _breath: 0, _chatter: -12,
  // items and tools
  pickup: 0, pickup_wood: -3, open_crate: -7, equip: -6, axe_swing: -6, axe_wood: -13, axe_flesh: -7,
  wood_split: -15, tree_fall: -12, rifle_shot: -5, rifle_bolt: -13, rifle_dry: -12, rifle_reload: -11,
  bullet_snow: -9, bullet_wood: -16, flare_shot: -3, flare_land: -15, light_click: -8, radio_crank: -2,
  radio_blip: -12, match_strike: -12, match_fail: -11,
  // fire
  fire_catch: -14, fire_feed: -18, fire_die: -17, fire_pop: -18,
  // wolves
  howl: -2, howl_far: -6, growl: -3, bark: 1.5, yelp: -6, wolf_die: -4, paws: 1,
  // world
  ice_creak: -7, ice_crack: -8, ice_break: -8, ice_boom: -11, splash: -11, gust: -13, branch_snow: -9,
  door: -5.5, log_lift: -2, log_drop: -8, generator_start: -6.5, generator_stop: -5.5, panel_install: -6.5,
  transmit: -10, metal_creak: -3.5, thunder: -13.5,
  _ice_ping: -1, _timber: -6, _trunk: -8, _tick: -2.5,
  // footsteps
  step_snow: -2, step_deep: -9, step_rock: -16.5, step_ice: -14.5, step_wood: -10, step_metal: -13, step_water: -7.5,
  // loops
  fire: 0, flare: -4, generator: -3, radio_static: -8, heli: -10, stove: 0, beacon: 0, wolf_breath: -3,
};
