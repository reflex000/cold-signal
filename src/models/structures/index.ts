// Registers every structure model (and the wreck's): importing this module is enough.
// Exports the driver that moves their named parts from the View.
import '../wreck';
import './cabin';
import './sheds';
import './cave';
import './camp';
import './tower';
import './posts';
export { createStructureDriver, applyStructureState, CRANK_TURNS, type StructureState } from './drive';
