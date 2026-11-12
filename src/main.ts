// Boot: the release page (index.html) runs the game shell. Everything else is in src/game/game.ts.
// Owner: GAME.
import { boot } from './game/game';

boot().catch(() => {
  // already reported on the loading screen and the console by Game.start()
});
