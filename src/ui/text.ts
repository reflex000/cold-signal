// Every word the interface says that does not come from the game: names, descriptions, the
// controls reference, the how-to pages, the credits. Plain, short, no exclamation marks.
import type { HurtCause, ItemId, PartId, ToolId } from '../sim/types';

/** Belt order: keys 1 to 5 and the slots of the touch tool wheel. */
export const TOOL_ORDER: readonly ToolId[] = ['axe', 'flashlight', 'flaregun', 'rifle', 'radio'];
export const TOOL_NAME: Record<ToolId, string> = {
  hands: 'Hands',
  axe: 'Axe',
  flashlight: 'Flashlight',
  flaregun: 'Flare gun',
  rifle: 'Rifle',
  radio: 'Radio',
};

export const PART_ORDER: readonly PartId[] = ['battery', 'handset', 'coil', 'tube', 'fuse'];
export const PART_NAME: Record<PartId, string> = {
  battery: 'Battery',
  handset: 'Handset',
  coil: 'Antenna coil',
  tube: 'Valve',
  fuse: 'Fuse',
};

export const SUPPLY_ORDER: readonly ItemId[] = ['stick', 'log', 'tinder', 'matches', 'bandage', 'ration', 'thermos', 'ammo', 'flare', 'cell'];

export interface ItemText {
  name: string;
  desc: string;
  /** Verb of the main action in the pack, if it has one. */
  use?: string;
}

export const ITEM: Record<ItemId, ItemText> = {
  axe: { name: 'Axe', desc: 'Turns dead standing trees and deadfall into sticks and split logs. A last resort against a wolf.', use: 'Take in hand' },
  flashlight: { name: 'Flashlight', desc: 'The cell drains while it is on. A wolf’s eyes shine in the beam.', use: 'Take in hand' },
  flaregun: { name: 'Flare gun', desc: 'One cartridge at a time. A flare burns for forty seconds and the pack will not cross its light.', use: 'Take in hand' },
  rifle: { name: 'Rifle', desc: 'Bolt action, five rounds. A shot scatters the pack for a while. Cold hands sway the aim.', use: 'Take in hand' },
  radio: { name: 'Hand-crank radio', desc: 'Crank it, hold it up and turn. The static clears into a tone as you face the nearest missing part.', use: 'Take in hand' },
  stick: { name: 'Dry sticks', desc: 'Three lay a campfire. One feeds a fire for forty seconds.' },
  log: { name: 'Split logs', desc: 'Each burns for about three minutes.' },
  tinder: { name: 'Tinder', desc: 'Birch bark and dry grass. With tinder a match almost always catches.' },
  matches: { name: 'Matches', desc: 'One lights a fire, or is lost to the wind.' },
  flare: { name: 'Flare cartridges', desc: 'For the flare gun. Save one to mark the pickup point.', use: 'Load' },
  ammo: { name: 'Rifle rounds', desc: 'There are not many on this mountain.', use: 'Load' },
  cell: { name: 'Flashlight cells', desc: 'A fresh cell gives the flashlight a full charge.', use: 'Load' },
  bandage: { name: 'Bandages', desc: 'Stops the bleeding and gives back some health. Alone, one will get you back on your feet.', use: 'Use' },
  ration: { name: 'Rations', desc: 'A fed body makes its own heat.', use: 'Eat' },
  thermos: { name: 'Thermos', desc: 'Something hot. Brings the core temperature up fast.', use: 'Drink' },
  part_battery: { name: 'Battery', desc: 'From the emergency beacon in the tail section. The transmitter will not wake without it.' },
  part_handset: { name: 'Handset', desc: 'The ranger’s radio handset. Carry it to the signal tower.' },
  part_coil: { name: 'Antenna coil', desc: 'Wound by hand at the survey camp. Carry it to the signal tower.' },
  part_tube: { name: 'Valve', desc: 'A transmitter valve, kept dry in an old survey cache. Carry it to the signal tower.' },
  part_fuse: { name: 'Fuse', desc: 'A glass fuse from the ice-fishing hut. Carry it to the signal tower.' },
};

/** Which tool a loose round, cartridge or cell goes into. */
export const LOADS: Partial<Record<ItemId, ToolId>> = { ammo: 'rifle', flare: 'flaregun', cell: 'flashlight' };

export const DEATH: Record<HurtCause | 'unknown', { title: string; line: string }> = {
  cold: { title: 'The cold took you', line: 'Your core fell below thirty degrees and you lay down in the snow.' },
  wolf: { title: 'The pack took you', line: 'They wait for the one who walks alone.' },
  fall: { title: 'You fell', line: 'The mountain does not forgive a careless step.' },
  water: { title: 'The lake took you', line: 'The ice was thinner than it looked.' },
  fire: { title: 'Burned', line: 'Too close, for too long.' },
  unknown: { title: 'You did not make it', line: 'The mountain keeps what it is given.' },
};

/** The co-op end: every human on the mountain is dead at once (stage 'lost'). */
export const LOST = { title: 'No one is left', line: 'The radio stays silent on the ridge. The snow covers the tracks by morning.' };

export interface ControlLine { k: string; a: string }
export const CONTROLS: { kbm: ControlLine[]; pad: ControlLine[]; touch: ControlLine[] } = {
  kbm: [
    { k: 'W A S D', a: 'Move' },
    { k: 'Mouse', a: 'Look' },
    { k: 'Shift', a: 'Sprint' },
    { k: 'Space', a: 'Jump' },
    { k: 'Ctrl / C', a: 'Crouch' },
    { k: 'E', a: 'Use. Hold for long actions' },
    { k: 'Left button', a: 'Swing, fire, crank' },
    { k: 'Right button', a: 'Aim, raise the light' },
    { k: 'R', a: 'Reload' },
    { k: 'F', a: 'Flashlight on / off' },
    { k: 'B', a: 'Lay a fire from three sticks' },
    { k: 'G', a: 'Drop what is in hand, put a log down' },
    { k: '1 – 5', a: 'Axe, flashlight, flare gun, rifle, radio' },
    { k: 'Q / wheel', a: 'Empty hands / next tool' },
    { k: 'Tab', a: 'Pack' },
    { k: 'Esc / M', a: 'Pause' },
  ],
  pad: [
    { k: 'Left stick', a: 'Move. Press to sprint' },
    { k: 'Right stick', a: 'Look' },
    { k: 'A', a: 'Jump' },
    { k: 'B', a: 'Crouch' },
    { k: 'X', a: 'Use. Hold for long actions' },
    { k: 'Y', a: 'Reload' },
    { k: 'RT', a: 'Swing, fire, crank' },
    { k: 'LT', a: 'Aim, raise the light' },
    { k: 'LB / RB', a: 'Previous / next tool' },
    { k: 'D-pad up', a: 'Flashlight on / off' },
    { k: 'View', a: 'Pack. Lay a fire from it' },
    { k: 'Menu', a: 'Pause' },
  ],
  touch: [
    { k: 'Left thumb', a: 'Move. The stick appears where you touch' },
    { k: 'Right thumb', a: 'Drag to look' },
    { k: 'Large button', a: 'Swing, fire, crank. Drag on it to keep looking' },
    { k: 'Sight', a: 'Aim, raise the light' },
    { k: 'Hand', a: 'Use what you are looking at. Hold for long actions' },
    { k: 'Arrows', a: 'Jump, crouch, sprint lock' },
    { k: 'Tool ring', a: 'Hold and slide to a tool, or tap and choose' },
    { k: 'Reload / light', a: 'Reload the rifle or flare gun, or switch the flashlight' },
    { k: 'Pack', a: 'Open the pack. Lay a fire from it' },
    { k: 'Pause', a: 'Pause' },
  ],
};

export const HOWTO: { h: string; p: string }[] = [
  { h: 'The cold', p: 'Your core temperature is the only number that matters. 37 is well. At 35 you shiver, at 33 frost creeps over your sight and your aim shakes, at 31 it starts to kill you. At 30 you go down. Wind, wet clothes and height take the heat; shelter, fire, food and other people give it back.' },
  { h: 'Fire', p: 'Three sticks lay a campfire. A match lights it; tinder makes it near certain, wind on an open fire makes it likely to fail and the match burns anyway. Feed it sticks, split logs or a heavy log. A dead fire keeps its embers for a while and relights without a match.' },
  { h: 'Wood', p: 'Sticks lie under the trees. The axe turns dead standing trees and deadfall into sticks and split logs. A heavy log does not fit a pack: one drags it slowly, two carry it at a walk.' },
  { h: 'Wolves', p: 'They howl before they come. They circle at the edge of sight and take whoever is alone, weak or down. They will not enter the light of a strong fire or a burning flare, and a rifle shot scatters them for a while.' },
  { h: 'The radio', p: 'Five parts of the transmitter are scattered over the mountain. Crank the hand radio, hold it up and turn: the static clears as you face the nearest one. Carry them to the signal tower on the north ridge, install them, charge the generator and send the call.' },
  { h: 'Weather', p: 'The storm rises and falls. In a whiteout you see a few metres and fires struggle. Travel in the clear spells and be near warmth when it closes in.' },
  { h: 'Coming back', p: 'Rest warm and still beside a fire and the place is kept. If you die you wake there with the fire burning, and with at least the matches, tinder and rounds you had then. Alone, a bandage gets you back on your feet once when you go down.' },
  { h: 'Together', p: 'Warmth is shared: by a fire, and by standing close. A downed friend bleeds out in a minute and a half and can be revived by holding on for five seconds. Stay within sight of each other.' },
];

export const CREDIT_LINE = 'Every mesh, texture and sound is made in code at load. Best with headphones.';
export const CREDITS: { h: string; p: string }[] = [
  { h: 'Cold Signal', p: 'A mountain, a storm and a dead radio.' },
  { h: 'Made with', p: 'three.js (MIT licence), WebGPU and WebGL 2, the Web Audio API, TypeScript and Vite.' },
  { h: 'No files', p: 'There are no art or audio files in this game. Every mesh, texture, sound and note is generated in code when it loads.' },
  { h: 'Thank you', p: 'For walking out.' },
];
