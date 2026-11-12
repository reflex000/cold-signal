// The whole stylesheet of the interface, injected once by createUI. No files, no web fonts.
// Sizes hang off one font-size on the root (.cs) that follows the smaller viewport side, so
// the same layout reads from a phone in landscape up to 4K. Colours: off-white on near-black,
// one amber accent; an ice tint and a flare red mark the cold and the blood.
export const CSS = /* css */ `
.cs{
  --fg:#ebe8e1;--fg2:rgba(235,232,225,.68);--fg3:rgba(235,232,225,.42);--line:rgba(235,232,225,.14);
  --ink:#07090c;--amber:#e6a640;--ice:#c3def2;--red:#e2603c;
  --ft:"Inter","Segoe UI","Helvetica Neue",system-ui,-apple-system,"Roboto",Arial,sans-serif;
  --fn:"Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow","Segoe UI",sans-serif;
  --sl:env(safe-area-inset-left,0px);--sr:env(safe-area-inset-right,0px);
  --st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px);
  --halo:0 0 .18em rgba(5,7,10,.74),0 0 .75em rgba(5,7,10,.42),0 .04em .1em rgba(5,7,10,.86);
  /* a soft shade behind text that may land on bright snow: reads as vignetting, not a panel */
  --smudge:radial-gradient(closest-side,rgba(6,8,12,.34),rgba(6,8,12,.17) 52%,rgba(6,8,12,.05) 80%,rgba(6,8,12,0));
  position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:10;
  font:300 clamp(12.5px,1.1vmin + 6px,40px)/1.4 var(--ft);color:var(--fg);
  -webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;
  -webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%;
  cursor:default;contain:layout style;
}
.cs.touch{font-size:clamp(13px,1.1vmin + 8.2px,40px)}
.cs *,.cs *::before,.cs *::after{box-sizing:border-box}
:where(.cs) button{all:unset;box-sizing:border-box;cursor:pointer;-webkit-tap-highlight-color:transparent}
:where(.cs) :where(h1,h2,p){margin:0;font-weight:inherit}
.cs svg.ic{display:block;width:1.5em;height:1.5em;fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round;overflow:visible;flex:none}
.cs svg.ic .f{fill:currentColor;stroke:none}
.cs svg.ic .ih{stroke:rgba(5,7,10,.5);stroke-width:3.4}
.cs svg.ic .ih .f{fill:rgba(5,7,10,.5);stroke:rgba(5,7,10,.5);stroke-width:2.2}
.cs .num{font-family:var(--fn);font-stretch:condensed;font-variant-numeric:tabular-nums}

@keyframes cs-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes cs-shiver{0%{transform:translate(0,0)}25%{transform:translate(.035em,-.02em)}50%{transform:translate(-.03em,.02em)}75%{transform:translate(.02em,.03em)}100%{transform:translate(0,0)}}
@keyframes cs-in{from{opacity:0}to{opacity:1}}
@keyframes cs-title{from{opacity:0;letter-spacing:.62em;text-indent:.62em}to{opacity:1;letter-spacing:.46em;text-indent:.46em}}
@keyframes cs-rise{from{opacity:0;transform:translateY(.7em)}to{opacity:1;transform:none}}
@keyframes cs-ping{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.7);opacity:0}}
@keyframes cs-load{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}

/* ------------------------------------------------------------------ screens ------------- */
.scr{position:absolute;inset:0;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .45s ease,visibility 0s .45s}
.scr.on{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .45s ease}

/* loading */
.ld{background:var(--ink);display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .9s ease,visibility 0s .9s}
.ld.on{transition:opacity .2s}
.ld-n{font:300 1.25em/1 var(--fn);letter-spacing:.62em;text-indent:.62em;text-transform:uppercase;color:var(--fg2)}
.ld-b{position:relative;width:min(22em,56vw);height:1px;margin:2.3em 0 1.25em;background:var(--line);overflow:hidden}
.ld-b i{position:absolute;inset:0;background:var(--fg);transform-origin:0 50%;transform:scaleX(0);transition:transform .35s ease}
.ld-b.idle i{width:28%;transform:none;animation:cs-load 1.6s ease-in-out infinite}
.ld-l{height:1.4em;font-size:.8em;letter-spacing:.24em;text-indent:.24em;text-transform:uppercase;color:var(--fg3)}

/* title */
.tt{transition:opacity 1.1s ease,visibility 0s 1.1s}
.tt-shade{position:absolute;inset:0;background:
  radial-gradient(120% 95% at 50% 40%,rgba(7,9,12,0) 0%,rgba(7,9,12,.22) 55%,rgba(7,9,12,.72) 100%),
  linear-gradient(rgba(7,9,12,.62),rgba(7,9,12,.2) 30%,rgba(7,9,12,.16) 52%,rgba(7,9,12,.8))}
.tt-head{position:absolute;left:0;right:0;top:23%;text-align:center;text-shadow:0 0 1.2em rgba(5,7,10,.5);transition:opacity .4s}
.tt-pre{font:400 .76em/1 var(--ft);letter-spacing:.66em;text-indent:.66em;text-transform:uppercase;color:var(--fg2)}
.tt-name{margin-top:.34em;font:300 min(7.4vw,17vh)/1 var(--fn);font-stretch:semi-condensed;letter-spacing:.46em;text-indent:.46em;text-transform:uppercase;white-space:nowrap}
.tt.on .tt-name{animation:cs-title 2.6s cubic-bezier(.2,.6,.2,1) both}
.tt-rule{width:3.2em;height:1px;margin:min(2.1em,4.6vh) auto 0;background:var(--amber)}
.tt-sub{margin-top:min(1.5em,3.4vh);font-size:.95em;letter-spacing:.16em;text-indent:.16em;color:var(--fg2)}
.tt-menu{position:absolute;left:0;right:0;bottom:calc(var(--sb) + 17%);display:flex;justify-content:center;gap:clamp(.6em,3.4vw,3.8em);transition:opacity .4s}
.tt.sub .tt-head,.tt.sub .tt-menu,.tt.sub .tt-foot{opacity:0;pointer-events:none}
.mi{position:relative;display:flex;align-items:center;justify-content:center;min-height:44px;padding:.8em .7em;font:400 .84em/1 var(--ft);letter-spacing:.3em;text-indent:.3em;text-transform:uppercase;white-space:nowrap;color:var(--fg2);transition:color .2s}
.mi::after{content:"";position:absolute;left:50%;bottom:.42em;width:0;height:1px;background:var(--amber);transition:width .25s ease,margin .25s ease}
.mi.sel{color:var(--fg)}
.mi.sel::after{width:1.8em;margin-left:-.9em}
.mi.ask{color:var(--amber)}
.tt-foot{position:absolute;left:0;right:0;bottom:calc(var(--sb) + 1.5em);text-align:center;font-size:.72em;letter-spacing:.18em;color:var(--fg3);transition:opacity .4s}

/* overlay: pause, settings, controls, how to play */
.ov{--gut:clamp(1.6em,7vw,10em);--navw:clamp(11em,21vw,15em)}
.ov-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(7,9,12,.95),rgba(7,9,12,.88) 42%,rgba(7,9,12,.74))}
.ov-nav{position:absolute;left:calc(var(--sl) + var(--gut));top:50%;width:var(--navw);transform:translateY(-50%);display:flex;flex-direction:column;align-items:flex-start}
.ov-ttl{font:300 1.7em/1 var(--fn);letter-spacing:.42em;text-transform:uppercase;white-space:nowrap}
.ov-rule{width:2.4em;height:1px;margin:1.15em 0 1.3em;background:var(--amber)}
.ni{position:relative;display:flex;align-items:center;min-height:2.3em;padding:.25em 0;font:300 1.28em/1.2 var(--ft);color:var(--fg2);white-space:nowrap;transition:color .2s,padding .2s}
.touch .ni{min-height:44px}
.ni::before{content:"";position:absolute;left:0;top:50%;width:0;height:1px;background:var(--amber);transition:width .2s}
.ni.sel{color:var(--fg);padding-left:1.15em}
.ni.sel::before{width:.7em}
.ni.cur{color:var(--fg)}
.ni.ask{color:var(--amber)}
.ni.gap{margin-top:.9em}
.ni.hide{display:none}
.ov-page{position:absolute;left:calc(var(--sl) + var(--gut) + var(--navw) + clamp(1.5em,5vw,6em));right:calc(var(--sr) + var(--gut));top:11%;bottom:11%;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin;scrollbar-color:rgba(235,232,225,.22) transparent;padding:0 1.4em 0 1.4em}
.pg{display:none;max-width:46em;animation:cs-in .3s ease}
.pg.on{display:block}
.sg{padding:2em 0 .7em;margin-bottom:.35em;border-bottom:1px solid var(--line);font:400 .68em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--fg3)}
.sg:first-child{padding-top:.2em}
.sr{position:relative;display:flex;align-items:center;min-height:2.5em;color:var(--fg2);cursor:pointer;transition:color .15s}
.touch .sr{min-height:44px}
.sr::before{content:"";position:absolute;left:-1.4em;top:50%;width:0;height:1px;background:var(--amber);transition:width .2s}
.sr.sel{color:var(--fg)}
.sr.sel::before{width:.8em}
.sr-l{flex:0 0 clamp(8.5em,32%,13em)}
.sr-c{flex:1;display:flex;align-items:center;flex-wrap:wrap;column-gap:1.25em;min-width:0}
.sr-v{flex:0 0 3.4em;text-align:left;font:300 1.08em/1 var(--fn);letter-spacing:.06em;font-variant-numeric:tabular-nums}
.sl{position:relative;flex:1;max-width:17em;height:2.4em;touch-action:none;cursor:ew-resize;--p:0%}
.touch .sl{height:44px}
.sl::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(235,232,225,.24)}
.sl-f{position:absolute;left:0;top:50%;width:var(--p);height:1px;background:var(--fg)}
.sl-h{position:absolute;left:var(--p);top:50%;width:1px;height:.95em;margin-top:-.475em;background:var(--fg);transition:background .15s}
.sr.sel .sl-h{width:2px;margin-left:-.5px;background:var(--amber)}
.op{position:relative;display:flex;align-items:center;min-height:2.3em;font-size:.94em;color:var(--fg3);transition:color .15s}
.touch .op{min-height:44px;padding:0 .2em}
.op::after{content:"";position:absolute;left:0;right:0;bottom:.42em;height:1px;background:var(--amber);transform:scaleX(0);transition:transform .2s}
.touch .op::after{bottom:.9em}
.op.on{color:var(--fg)}
.op.on::after{transform:none}
.gp{padding:.7em 0 2em;font:300 .95em/1.5 var(--fn);letter-spacing:.06em;color:var(--fg2)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:2.2em 3em;padding-bottom:2em}
.col h2{padding-bottom:.75em;margin-bottom:.6em;border-bottom:1px solid var(--line);font:400 .68em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--fg3)}
.kr{display:flex;gap:1em;padding:.32em 0;line-height:1.35}
.kr b{flex:0 0 6.6em;font:400 .95em/1.35 var(--fn);letter-spacing:.07em;color:var(--fg)}
.kr span{color:var(--fg2);font-size:.94em}
.how{column-width:19em;column-gap:3.2em;padding-bottom:2em}
.how section{break-inside:avoid;padding-bottom:1.7em}
.how h2{padding-bottom:.6em;font:400 .68em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--amber)}
.how p{color:var(--fg2);font-size:.95em;line-height:1.6}

/* pack */
.inv{--gut:clamp(1.4em,5.5vw,8em);--cell:clamp(44px,min(5.3em,12.6vh),9em)}
.inv-shade{position:absolute;inset:0;background:radial-gradient(130% 110% at 30% 45%,rgba(7,9,12,.9),rgba(7,9,12,.8))}
.inv-top{position:absolute;left:calc(var(--sl) + var(--gut));right:calc(var(--sr) + var(--gut));top:calc(var(--st) + min(2.2em,5.5vh));display:flex;align-items:center;gap:1.6em;height:44px}
.inv-top .mi{padding:.8em 0}
.inv-top .mi.cur{color:var(--fg)}
.inv-st{flex:1;display:flex;justify-content:flex-end;gap:1.8em;font:300 .95em/1 var(--fn);letter-spacing:.1em;color:var(--fg2);white-space:nowrap;overflow:hidden}
.inv-st span b{font-weight:300;font-size:.74em;letter-spacing:.3em;color:var(--fg3);margin-right:.7em;text-transform:uppercase;font-family:var(--ft)}
.inv-st .w{color:var(--amber)}
.inv-x{display:flex;align-items:center;justify-content:center;width:44px;height:44px;color:var(--fg2)}
.inv-x.sel{color:var(--fg)}
.inv-body{position:absolute;left:calc(var(--sl) + var(--gut));right:calc(var(--sr) + var(--gut));top:calc(var(--st) + min(2.2em,5.5vh) + 44px + min(1.4em,2.5vh));bottom:calc(var(--sb) + min(3.2em,7vh));display:none;gap:clamp(1.6em,4.5vw,5em)}
.inv-body.on{display:flex;animation:cs-in .3s ease}
.inv-l{flex:none;display:flex;flex-direction:column}
.inv-h{height:min(2.3em,5.6vh);display:flex;align-items:center;font:400 .66em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--fg3)}
.inv-h:not(:first-child){margin-top:min(.9em,1.6vh)}
.grid{display:grid;grid-template-columns:repeat(5,var(--cell));border-top:1px solid var(--line);border-left:1px solid var(--line)}
.cell{position:relative;width:var(--cell);height:var(--cell);border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--fg)}
.cell svg.ic{width:46%;height:46%;stroke-width:1.1}
.cell canvas{position:absolute;left:14%;top:14%;width:72%;height:72%}
.cell.cv svg.ic{display:none}
.cell.none svg.ic,.cell.none canvas{opacity:.16}
.cell .n{position:absolute;right:.5em;bottom:.3em;font:300 .95em/1 var(--fn);letter-spacing:.04em;color:var(--fg2)}
.cell .k{position:absolute;left:.5em;top:.4em;font:300 .7em/1 var(--fn);color:var(--fg3)}
.cell.held::after{content:"";position:absolute;left:50%;bottom:.42em;width:1.1em;height:1px;margin-left:-.55em;background:var(--amber)}
.cell.inst{color:var(--amber)}
.cell.sel{background:
  linear-gradient(var(--amber),var(--amber)) 0 0/.7em 1px no-repeat,linear-gradient(var(--amber),var(--amber)) 0 0/1px .7em no-repeat,
  linear-gradient(var(--amber),var(--amber)) 100% 0/.7em 1px no-repeat,linear-gradient(var(--amber),var(--amber)) 100% 0/1px .7em no-repeat,
  linear-gradient(var(--amber),var(--amber)) 0 100%/.7em 1px no-repeat,linear-gradient(var(--amber),var(--amber)) 0 100%/1px .7em no-repeat,
  linear-gradient(var(--amber),var(--amber)) 100% 100%/.7em 1px no-repeat,linear-gradient(var(--amber),var(--amber)) 100% 100%/1px .7em no-repeat,
  rgba(235,232,225,.035)}
.inv-r{flex:1;min-width:0;display:flex;gap:clamp(1.4em,3.5vw,4em);overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:none}
.inv-d{flex:1 1 18em;min-width:0;max-width:26em;padding-top:min(2.3em,5.6vh)}
.inv-dn{font:300 1.7em/1.1 var(--ft);letter-spacing:.01em}
.inv-dc{margin-top:.5em;font:300 1em/1 var(--fn);letter-spacing:.12em;color:var(--fg2);min-height:1em}
.inv-dd{margin-top:.9em;color:var(--fg2);font-size:.95em;line-height:1.55;min-height:3.1em}
.inv-a{margin-top:1em;display:flex;flex-direction:column;align-items:flex-start}
.inv-a .ni{font-size:1.08em;min-height:2.1em}
.touch .inv-a .ni{min-height:44px}
.inv-a .ni.no{color:var(--fg3);cursor:default}
.inv-a .amt{display:flex;align-items:center;gap:1.1em;min-height:2.1em;color:var(--fg3);font-size:.86em;letter-spacing:.04em}
.inv-f{flex:0 1 17em;min-width:13em;padding-top:min(2.3em,5.6vh)}
.inv-f h2{padding-bottom:.75em;margin-bottom:.5em;border-bottom:1px solid var(--line);font:400 .66em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--fg3)}
.fr{display:flex;align-items:center;gap:.8em;min-height:2em;color:var(--fg2);font-size:.94em}
.fr svg.ic{width:1.3em;height:1.3em}
.fr span{flex:1}
.fr b{font:300 1.06em/1 var(--fn);letter-spacing:.06em;color:var(--fg)}
.fr.short b{color:var(--amber)}
.fr.ok svg.ic{color:var(--fg)}
.fnote{margin-top:.7em;color:var(--fg3);font-size:.86em;line-height:1.55}
.inv-f .ni{margin-top:.5em;font-size:1.08em}
.inv-leg{position:absolute;left:calc(var(--sl) + var(--gut));right:calc(var(--sr) + var(--gut));bottom:calc(var(--sb) + min(1.2em,2.6vh));font-size:.76em;letter-spacing:.14em;color:var(--fg3);white-space:nowrap;overflow:hidden}
.inv-leg b{font:400 1em/1 var(--fn);letter-spacing:.1em;color:var(--fg2);margin-right:.5em}
.inv-leg span{margin-right:2em}
.touch .inv-leg{display:none}
.map{position:relative;flex:none;height:100%;aspect-ratio:1;max-width:60%;border:1px solid var(--line)}
.map canvas{position:absolute;inset:0;width:100%;height:100%;opacity:.92}
.map-m{position:absolute;width:0;height:0}
.map-m i{position:absolute;left:-.22em;top:-.22em;width:.44em;height:.44em;border-radius:50%;border:1px solid var(--fg)}
.map-m span{position:absolute;left:.7em;top:-.62em;font-size:.72em;letter-spacing:.16em;text-transform:uppercase;white-space:nowrap;color:var(--fg2);text-shadow:var(--halo)}
.map-m.l span{left:auto;right:.7em}
.map-m.poi i{width:.3em;height:.3em;left:-.15em;top:-.15em;border-radius:0;border-color:var(--fg2);transform:rotate(45deg)}
.map-m.me svg.ic{position:absolute;left:-.7em;top:-.7em;width:1.4em;height:1.4em;color:var(--amber);stroke-width:1.6}
.map-m.obj i{border-radius:0;border-color:var(--amber);transform:rotate(45deg)}
.map-m.obj span,.map-m.me span{color:var(--amber)}
.map-m.poi.obj i{width:.46em;height:.46em;left:-.23em;top:-.23em;border-width:1.5px}
.map-m.fire i{border:0;background:var(--amber)}
.map-m.down i{border-color:var(--red);background:var(--red)}
.map-side{flex:1;min-width:0;padding-top:.4em}
.map-side h2{padding-bottom:.75em;margin-bottom:.6em;border-bottom:1px solid var(--line);font:400 .66em/1 var(--ft);letter-spacing:.36em;text-transform:uppercase;color:var(--fg3)}
.map-side p{color:var(--fg2);font-size:.95em;line-height:1.6;margin-bottom:1.6em}
.map-none{color:var(--fg3);align-self:center;margin:auto}

/* death and the ending */
.end-shade{position:absolute;inset:0;background:radial-gradient(110% 100% at 50% 45%,rgba(7,9,12,.72),rgba(7,9,12,.93))}
.wn .end-shade{background:radial-gradient(110% 100% at 50% 40%,rgba(7,9,12,.5),rgba(7,9,12,.9))}
.end{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:calc(var(--st) + 1.5em) 2em calc(var(--sb) + 1.5em)}
.end-pre{font:400 .74em/1 var(--ft);letter-spacing:.6em;text-indent:.6em;text-transform:uppercase;color:var(--fg3)}
.end-t{margin-top:.55em;font:300 min(3.6em,11vh)/1.1 var(--fn);letter-spacing:.3em;text-indent:.3em;text-transform:uppercase}
.end-rule{width:3.2em;height:1px;margin:min(1.8em,4vh) 0 min(1.5em,3.4vh);background:var(--amber)}
.dd .end-rule{background:var(--red)}
.end-l{color:var(--fg2);font-size:1.02em;letter-spacing:.03em;max-width:34em}
.end-s{margin-top:min(1.7em,3.6vh);display:flex;gap:clamp(1.6em,4vw,4em);justify-content:center}
.end-s div{display:flex;flex-direction:column;align-items:center;gap:.55em}
.end-s b{font:300 1.75em/1 var(--fn);letter-spacing:.05em;font-variant-numeric:tabular-nums}
.end-s span{font-size:.66em;letter-spacing:.3em;text-indent:.3em;text-transform:uppercase;color:rgba(235,232,225,.56)}
.end-m{margin-top:min(2.4em,5vh);display:flex;gap:clamp(.6em,3vw,3.4em);justify-content:center}
.scr.on .end>*{animation:cs-rise 1.1s ease both}
.scr.on .end>*:nth-child(2){animation-delay:.25s}.scr.on .end>*:nth-child(3){animation-delay:.6s}
.scr.on .end>*:nth-child(4){animation-delay:.9s}.scr.on .end>*:nth-child(5){animation-delay:1.2s}
.scr.on .end>*:nth-child(6){animation-delay:1.5s}.scr.on .end>*:nth-child(7){animation-delay:1.8s}
.end-c{margin-top:min(2em,4.4vh);display:grid;grid-template-columns:repeat(2,minmax(0,19em));gap:.9em 3em;text-align:left;max-width:44em}
.end-c h2{font:400 .64em/1 var(--ft);letter-spacing:.34em;text-transform:uppercase;color:var(--fg3);padding-bottom:.5em}
.end-c p{font-size:.86em;line-height:1.5;color:var(--fg2)}

/* rotate notice (touch, portrait) */
.rot{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:1.2em;background:var(--ink);text-align:center;pointer-events:auto;z-index:50}
.rot svg.ic{width:3.4em;height:3.4em;color:var(--fg2)}
.rot b{font:300 1.3em/1 var(--fn);letter-spacing:.34em;text-indent:.34em;text-transform:uppercase}
.rot span{font-size:.9em;color:var(--fg3);letter-spacing:.06em}
@media (orientation:portrait){.cs.touch .rot{display:flex}}

/* ------------------------------------------------------------------ HUD ----------------- */
.hud{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .5s ease,visibility 0s .5s;text-shadow:var(--halo)}
.hud.on{opacity:1;visibility:visible;transition:opacity .7s ease}
.hud::before{content:"";position:absolute;left:0;right:0;top:0;height:19%;background:linear-gradient(rgba(6,8,12,.46),rgba(6,8,12,.18) 45%,rgba(6,8,12,0))}
.hud::after{content:"";position:absolute;left:0;right:0;bottom:0;height:34%;background:linear-gradient(rgba(6,8,12,0),rgba(6,8,12,.2) 55%,rgba(6,8,12,.54))}
.hud>*{z-index:1}

/* compass */
.cp{position:absolute;left:50%;top:calc(var(--st) + 1.15em);width:min(30em,60vw);height:3.6em;margin-left:calc(min(30em,60vw)/-2);opacity:.95;transition:opacity 1.6s ease}
.cp.idle{opacity:.5}
.cp-win{position:absolute;left:0;right:0;top:0;height:1.9em;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 17%,#000 83%,transparent);mask-image:linear-gradient(90deg,transparent,#000 17%,#000 83%,transparent)}
.cp-strip{position:absolute;left:50%;top:0;height:100%;will-change:transform}
.cp-t{position:absolute;top:0;width:1px;height:.3em;background:var(--fg);opacity:.6;box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.cp-t.m{height:.58em;opacity:.9}
.cp-p{position:absolute;top:0;width:0;height:100%}
.cp-l{position:absolute;left:0;top:.86em;transform:translateX(-50%);font:300 .74em/1 var(--fn);letter-spacing:.1em;white-space:nowrap;color:rgba(235,232,225,.82)}
.cp-l.c{top:.78em;font-size:.98em;font-weight:400;color:var(--fg)}
.cp-c{position:absolute;left:50%;top:-.42em;width:1px;height:.5em;background:var(--amber);box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.cp-m{position:absolute;left:50%;top:2.25em;width:0;height:0;will-change:transform}
.cp-m i{position:absolute;left:-.21em;top:-.21em;width:.42em;height:.42em;border:1px solid var(--fg);border-radius:50%;box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.cp-m span{position:absolute;left:0;top:.62em;transform:translateX(-50%);white-space:nowrap;font:300 .76em/1 var(--fn);letter-spacing:.1em;color:var(--fg2);opacity:0;transition:opacity .3s}
.cp-m.lab span{opacity:1}
.cp-m.k-objective i{left:-.24em;top:-.24em;width:.48em;height:.48em;border-radius:0;border-color:var(--amber);transform:rotate(45deg)}
.cp-m.k-objective span{color:var(--amber)}
.cp-m.k-fire i{border:0;background:var(--amber);width:.34em;height:.34em;left:-.17em;top:-.17em}
.cp-m.k-poi i{border-radius:0;border-width:0 0 0 1px;width:1px;height:.42em;left:0;border-color:var(--fg2)}
.cp-m.k-ping i::after{content:"";position:absolute;inset:-1px;border:1px solid var(--fg);border-radius:50%;animation:cs-ping 1.4s ease-out infinite}
.cp-m.edge i{opacity:.75}
.cp-m.edge.k-objective.e-l i{border-width:0 0 1px 1px}
.cp-m.edge.k-objective.e-r i{border-width:1px 1px 0 0}

/* top centre: hint, and on touch the toasts */
.tcn{position:absolute;left:50%;top:calc(var(--st) + 5.5em);width:min(36em,58vw);margin-left:calc(min(36em,58vw)/-2);display:flex;flex-direction:column;align-items:center;gap:.8em}
.hn{position:relative;max-width:100%;text-align:center;font-size:.96em;letter-spacing:.03em;line-height:1.45;opacity:0;transition:opacity .7s ease}
.hn::before{content:"";position:absolute;inset:-.8em -2.4em;background:var(--smudge);z-index:-1}
.hn.on{opacity:1}
.hn:empty{display:none}

/* objective and parts */
.ob{position:absolute;left:calc(var(--sl) + 2.2em);top:calc(var(--st) + 1.35em);max-width:min(24em,30vw);transition:opacity 1.6s ease}
.ob.dim{opacity:.6}
.ob-l{display:flex;align-items:baseline;gap:.75em;line-height:1.35;letter-spacing:.02em}
.ob-l i{flex:none;width:.44em;height:.44em;border:1px solid var(--amber);transform:translateY(-.12em) rotate(45deg);box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.ob-s{margin:.3em 0 0 1.2em;font:300 1.25em/1 var(--fn);letter-spacing:.1em;color:var(--amber);font-variant-numeric:tabular-nums}
.ob-s:empty{display:none}
.pt{display:flex;gap:.5em;margin:.8em 0 0 1.1em;transition:opacity .8s}
.pt.hide{opacity:0}
.pt svg.ic{width:1.4em;height:1.4em;opacity:.34;transition:opacity .6s,color .6s}
.pt svg.ic.held{opacity:1}
.pt svg.ic.inst{opacity:1;color:var(--amber)}

/* teammates */
.tm{position:absolute;right:calc(var(--sr) + 2.2em);top:calc(var(--st) + 1.35em);display:flex;flex-direction:column;align-items:flex-end;gap:.34em}
.touch .tm{position:static;margin-top:.8em;align-items:flex-start;gap:.28em}
.mate{display:flex;align-items:baseline;gap:.85em;opacity:.66;transition:opacity .6s,color .6s;white-space:nowrap}
.mate.att{opacity:1}
.mate b{font:400 .72em/1 var(--ft);letter-spacing:.24em;text-transform:uppercase}
.mate .s{font:400 .68em/1 var(--ft);letter-spacing:.2em;text-transform:uppercase}
.mate .s:empty{display:none}
.mate .c,.mate .d{font:300 1em/1 var(--fn);letter-spacing:.06em;font-variant-numeric:tabular-nums;text-align:right}
.mate .c{min-width:2.5em}
.mate .d{min-width:3.1em;color:var(--fg2)}
.mate.cold .c{color:var(--ice)}
.mate.frz .c,.mate.frz .s{color:var(--amber)}
.mate.down{opacity:1}
.mate.down .s{color:var(--red)}
.mate.down b{color:var(--fg)}
.mate.down .s{animation:cs-pulse 1s ease-in-out infinite}
.mate.gone{opacity:.4}
.touch .mate{flex-direction:row}

/* body temperature */
.tp{position:absolute;left:50%;bottom:calc(var(--sb) + 1.15em);width:17em;height:6.5em;margin-left:-8.5em;transition:opacity 1.8s ease,color .8s ease}
.tp.calm{opacity:.46}
.tp svg.arc{position:absolute;left:0;top:0;width:100%;height:4.25em;overflow:visible;fill:none;stroke-linecap:round}
.arc .u{stroke:rgba(5,7,10,.34);stroke-width:3.6}
.arc .b{stroke:currentColor;stroke-width:1;opacity:.34}
.arc .t{stroke:currentColor;stroke-width:.8;opacity:.6}
.arc .th{stroke:currentColor;stroke-width:1;opacity:.95}
.arc .f{stroke:currentColor;stroke-width:1.5}
.arc .n{stroke:currentColor;stroke-width:1.6}
.tp-read{position:absolute;left:0;right:0;top:1.62em;display:flex;justify-content:center;align-items:flex-start}
.tp-num{position:relative;font:300 2.05em/1 var(--fn);letter-spacing:.02em;font-variant-numeric:tabular-nums}
.tp-num sup{position:absolute;left:100%;top:.08em;margin-left:.12em;font-size:.5em;line-height:1;opacity:.8}
.arc .tr{fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:0;transition:opacity .5s}
.arc .tr.on{opacity:1}
.arc .tr .h{stroke:rgba(5,7,10,.45);stroke-width:3.4}
.arc .tr .v{stroke:currentColor;stroke-width:1.3}
.tp-low{position:absolute;left:0;right:0;top:4.05em;display:flex;flex-direction:column;align-items:center;gap:.55em}
.tp-st{display:none;font:400 .64em/1 var(--ft);letter-spacing:.46em;text-indent:.46em;text-transform:uppercase}
.tp-fx{display:flex;justify-content:center;gap:1em;height:1.15em;color:var(--fg)}
.fx{display:none;align-items:center;gap:.32em;font:300 .86em/1 var(--fn);letter-spacing:.06em;animation:cs-in .6s ease}
.fx.on{display:flex}
.fx svg.ic{width:1.15em;height:1.15em}
.fx.w{color:var(--amber)}
.fx.g{color:var(--fg)}
.vt{position:absolute;top:3.4em;width:3.5em;height:2px;color:var(--fg);background:rgba(235,232,225,.24);box-shadow:0 0 0 .5px rgba(5,7,10,.3);transition:opacity .9s ease 1.4s}
.vt i{position:absolute;inset:0;background:currentColor}
.vt.h{right:calc(50% + 3.6em)}.vt.h i{transform-origin:100% 50%}
.vt.s{left:calc(50% + 3.6em)}.vt.s i{transform-origin:0 50%}
.vt svg.ic{position:absolute;top:-.5em;width:1em;height:1em}
.vt.h svg.ic{left:-1.45em}.vt.s svg.ic{right:-1.45em}
.vt.full{opacity:0}
.vt.low{color:var(--amber)}
.vt.h.low{color:var(--red);animation:cs-pulse 1s ease-in-out infinite}
.tp.s1{color:var(--ice)}
.tp.s2{color:var(--amber)}
.tp.s3{color:var(--red)}
.tp.s1 .tp-st,.tp.s2 .tp-st,.tp.s3 .tp-st{display:block}
.tp.s1 .arc .f{stroke-width:1.8}
.tp.s2 .arc .f{stroke-width:2.1;stroke-dasharray:3.2 1.5}
.tp.s3 .arc .f{stroke-width:2.6;stroke-dasharray:1.3 2.1}
.tp.s2 .tp-num{animation:cs-shiver .32s steps(4) infinite}
.tp.s3 .tp-num{animation:cs-shiver .2s steps(4) infinite}
.tp.s3 .tp-st,.tp.s3 svg.arc{animation:cs-pulse .9s ease-in-out infinite}

/* held tool and belt */
.tl{position:absolute;right:calc(var(--sr) + 2.2em);bottom:calc(var(--sb) + 1.6em);display:flex;flex-direction:column;align-items:flex-end;gap:.75em}
.touch .tl{display:none}
.tl-m{display:flex;flex-direction:column;align-items:flex-end;gap:.5em;transition:opacity 1.2s ease}
.tl-m.dim{opacity:.55}
.tl-m.hide{opacity:0}
.tl-h{display:flex;align-items:center;gap:.7em}
.tl-h svg.ic{width:1.9em;height:1.9em}
.tl-n{font:400 .74em/1 var(--ft);letter-spacing:.3em;text-transform:uppercase;color:var(--fg)}
.tl-a{display:flex;align-items:baseline;justify-content:flex-end;gap:.5em;font:300 2.05em/1 var(--fn);letter-spacing:.03em;font-variant-numeric:tabular-nums}
.tl-a small{font-size:.5em;color:var(--fg2);letter-spacing:.08em}
.tl-a.empty{color:var(--amber)}
.tl-a:empty{display:none}
.tl-x{display:flex;align-items:center;gap:.8em;font:300 .9em/1 var(--fn);letter-spacing:.08em;color:var(--fg2)}
.tl-x.hide{display:none}
.ln{position:relative;width:5.6em;height:2px;background:rgba(235,232,225,.24);box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.ln i{position:absolute;inset:0;background:var(--fg);transform-origin:0 50%}
.ln.low i{background:var(--amber)}
.sig{display:flex;align-items:flex-end;gap:.2em;height:.95em}
.sig.hide{display:none}
.sig i{width:2px;background:rgba(235,232,225,.3);box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.sig i:nth-child(1){height:30%}.sig i:nth-child(2){height:47%}.sig i:nth-child(3){height:64%}.sig i:nth-child(4){height:82%}.sig i:nth-child(5){height:100%}
.sig i.on{background:var(--amber)}
.bl{display:flex;gap:.95em;opacity:0;transition:opacity .6s ease}
.bl.on{opacity:1}
.bl-s{display:flex;flex-direction:column;align-items:center;gap:.25em;color:var(--fg3)}
.bl-s svg.ic{width:1.35em;height:1.35em;opacity:.3}
.bl-s b{font:300 .7em/1 var(--fn)}
.bl-s.own svg.ic{opacity:.8}
.bl-s.own{color:var(--fg2)}
.bl-s.cur{color:var(--fg)}
.bl-s.cur svg.ic{opacity:1}
.bl-s.cur b{color:var(--amber)}

/* crosshair and the focus prompt */
.xh{position:absolute;left:50%;top:50%;width:0;height:0}
.xh i{position:absolute;opacity:0;transition:opacity .15s,transform .2s}
.xh .dot{width:3px;height:3px;margin:-1.5px;border-radius:50%;background:var(--fg);box-shadow:0 0 0 1px rgba(5,7,10,.4)}
.xh .ring{width:1.15em;height:1.15em;margin:-.575em;border-radius:50%;border:1px solid var(--fg);box-shadow:0 0 0 .5px rgba(5,7,10,.3),inset 0 0 0 .5px rgba(5,7,10,.3);transform:scale(.5)}
.xh .aim{width:1.7em;height:1.7em;margin:-.85em;transform:scale(1.5);background:
  linear-gradient(var(--fg),var(--fg)) 50% 0/1px .42em no-repeat,linear-gradient(var(--fg),var(--fg)) 50% 100%/1px .42em no-repeat,
  linear-gradient(var(--fg),var(--fg)) 0 50%/.42em 1px no-repeat,linear-gradient(var(--fg),var(--fg)) 100% 50%/.42em 1px no-repeat;
  filter:drop-shadow(0 0 1px rgba(5,7,10,.7))}
.xh.k-dot .dot,.xh.k-ring .dot,.xh.k-aim .dot{opacity:.92}
.xh.k-ring .ring{opacity:.92;transform:none}
.xh.k-aim .aim{opacity:.92;transform:none}
.fc{position:absolute;left:50%;top:calc(50% + 2.3em);width:max-content;max-width:min(34em,80vw);display:flex;flex-direction:column;align-items:center;opacity:0;transform:translate(-50%,.4em);transition:opacity .2s ease,transform .2s ease}
.fc::before{content:"";position:absolute;inset:-1.1em -2.6em -1.2em;background:var(--smudge);z-index:-1}
.fc.on{opacity:1;transform:translate(-50%,0)}
.fc-r{display:flex;align-items:center;gap:.75em}
.fc-k{position:relative;width:2.15em;height:2.15em;flex:none}
.touch .fc-k{display:none}
.fc-k svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);fill:none;overflow:visible}
.fc-k .bg{stroke:rgba(235,232,225,.5);stroke-width:1;fill:rgba(7,9,12,.32)}
.fc-k .pr{stroke:var(--amber);stroke-width:2;stroke-linecap:round}
.fc-k b{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:400 .95em/1 var(--fn)}
.fc-v{font-weight:400;letter-spacing:.02em;white-space:nowrap}
.fc-v span{font-weight:300;color:rgba(235,232,225,.82);margin-left:.5em}
.fc-o{margin-top:.4em;font-size:.82em;letter-spacing:.08em;color:rgba(235,232,225,.86)}
.fc-o:empty{display:none}
.touch .fc-o{margin-top:.2em}

/* toasts, lore, place card */
.ts{position:absolute;left:calc(var(--sl) + 2.2em);bottom:calc(var(--sb) + 2.4em);display:flex;flex-direction:column;align-items:flex-start;gap:.55em}
.tcn .ts{position:static;align-items:center}
.to{position:relative;display:flex;align-items:center;gap:.7em;font-size:.96em;letter-spacing:.02em;opacity:0;transform:translateX(-.7em);transition:opacity .4s ease,transform .4s ease}
.tcn .to{transform:translateY(-.4em)}
.to.on{opacity:1;transform:none}
.to.out{opacity:0;transform:none;transition:opacity .7s ease}
.to svg.ic{width:1.3em;height:1.3em}
.to.k-info{color:var(--fg2)}
.to.k-warn svg.ic,.to.k-part svg.ic,.to.k-objective svg.ic{color:var(--amber)}
.to.k-part{font-size:1.06em;letter-spacing:.05em}
.lo{position:absolute;left:50%;bottom:calc(var(--sb) + 9.6em);width:min(36em,62vw);margin-left:calc(min(36em,62vw)/-2);text-align:center;font-style:italic;font-weight:400;font-size:1.02em;line-height:1.5;letter-spacing:.02em;opacity:0;transition:opacity 1s ease}
.lo::before{content:"";position:absolute;inset:-1em -3em;background:var(--smudge);opacity:.75;z-index:-1}
.lo.on{opacity:1}
.pl{position:absolute;left:0;right:0;top:25%;text-align:center;opacity:0;transition:opacity 1.6s ease}
.pl::before{content:"";position:absolute;left:50%;width:min(46em,84vw);margin-left:calc(min(46em,84vw)/-2);top:-2.4em;bottom:-2.2em;background:var(--smudge);opacity:.72;z-index:-1}
.pl.on{opacity:1;transition:opacity 1.2s ease}
.pl-n{font:300 2.5em/1.1 var(--fn);letter-spacing:.5em;text-indent:.5em;text-transform:uppercase}
.pl-r{width:0;height:1px;margin:1em auto .85em;background:var(--fg);opacity:.7;transition:width 2s ease}
.pl.on .pl-r{width:5.5em}
.pl-s{font:300 .92em/1 var(--fn);letter-spacing:.32em;text-indent:.32em;color:var(--fg)}

/* downed */
.dw{position:absolute;left:0;right:0;top:24%;text-align:center;opacity:0;visibility:hidden;transition:opacity .8s ease,visibility 0s .8s}
.dw::before{content:"";position:absolute;left:50%;width:min(40em,84vw);margin-left:calc(min(40em,84vw)/-2);top:-2.6em;bottom:-2.2em;background:var(--smudge);z-index:-1}
.dw.on{opacity:1;visibility:visible;transition:opacity .8s ease}
.dw-t{font:300 2.8em/1 var(--fn);letter-spacing:.62em;text-indent:.62em;text-transform:uppercase;color:var(--red)}
.dw-b{position:relative;width:14em;height:2px;margin:1.3em auto .8em;background:rgba(235,232,225,.22);box-shadow:0 0 0 .5px rgba(5,7,10,.3)}
.dw-b i{position:absolute;inset:0;background:var(--red)}
.dw-c{font:300 1.5em/1 var(--fn);letter-spacing:.12em;font-variant-numeric:tabular-nums}
.dw-h{margin-top:1em;font-size:.96em;line-height:1.7;color:var(--fg)}
.dw-h span{display:block}
.dw-h span+span{color:var(--fg2)}
.rv{display:none;align-items:center;justify-content:center;gap:.8em;margin-top:1.1em;color:var(--fg)}
.rv.on{display:flex}
.rv .fc-k{display:block}
.hud.down .tl,.hud.down .xh,.hud.down .pl{opacity:0}
.fps{position:absolute;left:calc(var(--sl) + 1em);bottom:calc(var(--sb) + .7em);font:300 .76em/1 var(--fn);letter-spacing:.12em;color:var(--fg2);font-variant-numeric:tabular-nums}
.fps:empty{display:none}

/* ------------------------------------------------------------------ touch --------------- */
.tc{position:absolute;inset:0;--tb:clamp(46px,13.5vmin,80px);opacity:0;visibility:hidden;transition:opacity .35s ease,visibility 0s .35s}
.tc.on{opacity:1;visibility:visible;transition:opacity .35s ease}
.tz{position:absolute;inset:0;touch-action:none}
.tc.on .tz{pointer-events:auto}
.tb{position:absolute;width:var(--tb);height:var(--tb);border-radius:50%;display:flex;align-items:center;justify-content:center;touch-action:none;color:var(--fg);
  background:radial-gradient(circle,rgba(7,9,12,.08),rgba(7,9,12,.24));box-shadow:inset 0 0 0 1px rgba(235,232,225,.44),0 0 0 .5px rgba(5,7,10,.18);transition:background .12s,box-shadow .12s,opacity .25s,transform .12s,color .2s}
.tc.on .tb{pointer-events:auto}
.tb svg.ic{width:44%;height:44%}
.tb.dn{background:radial-gradient(circle,rgba(235,232,225,.34),rgba(235,232,225,.16));box-shadow:inset 0 0 0 1.5px var(--fg);transform:scale(.95)}
.tb.lk{color:var(--amber);box-shadow:inset 0 0 0 1.5px var(--amber)}
.tc.on .tb.off,.tb.off{opacity:0;pointer-events:none}
.tb.quiet{background:none;box-shadow:none}
.tb.quiet svg.ic{width:50%;height:50%}
.tb-pri{right:calc(var(--sr) + var(--tb)*.5);bottom:calc(var(--sb) + var(--tb)*.95);width:calc(var(--tb)*1.5);height:calc(var(--tb)*1.5)}
.tb-pri svg.ic{width:40%;height:40%}
.tb-aim{right:calc(var(--sr) + var(--tb)*2.2);bottom:calc(var(--sb) + var(--tb)*.3)}
.tb-cro{right:calc(var(--sr) + var(--tb)*2.25);bottom:calc(var(--sb) + var(--tb)*1.55)}
.tb-jmp{right:calc(var(--sr) + var(--tb)*.45);bottom:calc(var(--sb) + var(--tb)*2.7)}
.tb-use{right:calc(var(--sr) + var(--tb)*1.85);bottom:calc(var(--sb) + var(--tb)*2.85);width:calc(var(--tb)*1.15);height:calc(var(--tb)*1.15);box-shadow:inset 0 0 0 1px rgba(235,232,225,.3)}
.tb-use svg.rg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);fill:none;overflow:visible}
.tb-use svg.rg circle{stroke:var(--amber);stroke-width:2.2;stroke-linecap:round}
.tb-use .lb{position:absolute;right:calc(100% + .7em);top:50%;transform:translateY(-50%);white-space:nowrap;font:400 .92em/1 var(--ft);letter-spacing:.04em;text-shadow:var(--halo)}
.tb-spr{right:calc(var(--sr) + var(--tb)*3.5);bottom:calc(var(--sb) + var(--tb)*.4)}
.tb-ctx{right:calc(var(--sr) + var(--tb)*3.5);bottom:calc(var(--sb) + var(--tb)*1.65)}
.tb-whl{right:calc(var(--sr) + var(--tb)*.45);bottom:calc(var(--sb) + var(--tb)*3.95)}
.tb-whl .lb{position:absolute;right:calc(100% + .7em);top:50%;transform:translateY(-50%);white-space:nowrap;font:300 1.5em/1 var(--fn);letter-spacing:.04em;text-shadow:var(--halo);font-variant-numeric:tabular-nums}
.tb-whl .lb small{font-size:.55em;color:var(--fg2);margin-left:.4em}
.tb-whl .lb.empty{color:var(--amber)}
.tb-pau{right:calc(var(--sr) + var(--tb)*.25);top:calc(var(--st) + var(--tb)*.12)}
.tb-pck{right:calc(var(--sr) + var(--tb)*1.3);top:calc(var(--st) + var(--tb)*.12)}
.stk{position:absolute;left:0;top:0;width:calc(var(--tb)*2.3);height:calc(var(--tb)*2.3);margin:calc(var(--tb)*-1.15) 0 0 calc(var(--tb)*-1.15);border-radius:50%;box-shadow:inset 0 0 0 1px rgba(235,232,225,.2);opacity:.5;transition:opacity .25s;will-change:transform}
.stk.on{opacity:1;box-shadow:inset 0 0 0 1px rgba(235,232,225,.4);background:radial-gradient(circle,rgba(7,9,12,.04) 40%,rgba(7,9,12,.3))}
.stk i{position:absolute;left:50%;top:50%;width:var(--tb);height:var(--tb);margin:calc(var(--tb)*-.5);border-radius:50%;background:rgba(7,9,12,.22);box-shadow:inset 0 0 0 1px rgba(235,232,225,.35);will-change:transform}
.stk.on i{background:rgba(235,232,225,.22);box-shadow:inset 0 0 0 1px rgba(235,232,225,.8)}
.stk.run i{box-shadow:inset 0 0 0 1.5px var(--amber)}
.tw{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s .18s;touch-action:none}
.tw.on{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .18s ease}
.tw-c{position:absolute;left:50%;top:50%;width:0;height:0}
.tw-r{position:absolute;width:calc(var(--tb)*4.7);height:calc(var(--tb)*4.7);margin:calc(var(--tb)*-2.35);border-radius:50%;background:radial-gradient(circle,rgba(7,9,12,.5) 0%,rgba(7,9,12,.66) 62%,rgba(7,9,12,.4) 70.5%,rgba(7,9,12,0) 71%);box-shadow:inset 0 0 0 1px rgba(235,232,225,.14)}
.tw-s{position:absolute;width:var(--tb);height:var(--tb);margin:calc(var(--tb)*-.5);border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--fg2);transition:color .12s,box-shadow .12s,background .12s}
.tw-s svg.ic{width:52%;height:52%}
.tw-s.no{color:rgba(235,232,225,.16)}
.tw-s.cur{box-shadow:inset 0 0 0 1px rgba(235,232,225,.3)}
.tw-s.hot{color:var(--fg);background:rgba(235,232,225,.12);box-shadow:inset 0 0 0 1.5px var(--amber)}
.tw-n{position:absolute;left:-6em;width:12em;top:-.9em;text-align:center}
.tw-n b{display:block;font:400 .74em/1 var(--ft);letter-spacing:.3em;text-indent:.3em;text-transform:uppercase}
.tw-n span{display:block;margin-top:.5em;font:300 1.1em/1 var(--fn);letter-spacing:.08em;color:var(--fg2);min-height:1em}

/* ------------------------------------------------------------------ additions ----------- */
/* phones: one column on the left (objective, parts, teammates) and a narrower compass */
.touch .cp{width:min(30em,40vw);margin-left:calc(min(30em,40vw)/-2)}
.touch .tcn{width:min(30em,46vw);margin-left:calc(min(30em,46vw)/-2)}
.touch .ob{max-width:calc(30vw - 3.4em);font-size:.92em}
.touch .pl{top:27%}
.touch .pl-n{font-size:1.9em}
.touch .hud.tsv .pl{opacity:0;transition:opacity .3s}
.touch .lo{bottom:calc(var(--sb) + 8.8em);font-size:.9em;width:min(30em,50vw);margin-left:calc(min(30em,50vw)/-2)}
.touch .fc{top:calc(50% + 1.9em)}
.touch .fc-v span{margin-left:0}
.touch .ob::before{content:"";position:absolute;inset:-1.4em -3.4em -1.6em -2.6em;background:var(--smudge);opacity:.8;z-index:-1}
.touch .dw-t{font-size:2.1em}
.hud.down .hn.on{opacity:0}
@media (max-height:560px){.end-c{display:none}}
.cs [hidden]{display:none!important}
.cs.photo>*{opacity:0!important;visibility:hidden!important}
.cp-l.d{top:1.02em;font-size:.6em;letter-spacing:.04em;color:rgba(235,232,225,.5)}
.cp-m.k-down i{border-color:var(--red);background:var(--red);animation:cs-pulse 1s ease-in-out infinite}
.cp-m.k-down span{color:var(--red)}
.cp-m.k-player i{width:.36em;height:.36em;left:-.18em;top:-.18em;border-color:var(--fg2)}
.hud.wo::before{background:linear-gradient(rgba(6,8,12,.56),rgba(6,8,12,0))}
.hud.wo::after{background:linear-gradient(rgba(6,8,12,0),rgba(6,8,12,.6))}
.ob.hide{opacity:0}
.ln.hide{display:none}
.dm{position:absolute;left:0;top:0;width:0;height:0;color:var(--red);opacity:0;transition:opacity .4s ease;will-change:transform}
.dm.on{opacity:1}
.dm i{position:absolute;left:-.34em;top:-.34em;width:.68em;height:.68em;border:1.5px solid currentColor;transform:rotate(45deg);box-shadow:0 0 0 .5px rgba(5,7,10,.4);animation:cs-pulse 1.1s ease-in-out infinite}
.dm span{position:absolute;left:0;top:.85em;transform:translateX(-50%);white-space:nowrap;text-align:center}
.dm em{display:block;font:400 .74em/1.2 var(--ft);font-style:normal;color:var(--fg);letter-spacing:.24em;text-indent:.24em;text-transform:uppercase}
.dm b{display:block;margin-top:.2em;font:300 1.02em/1 var(--fn);letter-spacing:.06em;color:var(--fg)}
.pg-big{font:300 1.5em/1.35 var(--ft);letter-spacing:.01em;max-width:24em;padding:.3em 0 .4em}
.pg-parts{display:grid;grid-template-columns:repeat(auto-fill,minmax(12em,1fr));column-gap:2.5em}
.pp{display:flex;justify-content:space-between;align-items:baseline;padding:.45em 0;border-bottom:1px solid rgba(235,232,225,.06);color:var(--fg2)}
.pp b{font:300 .8em/1 var(--ft);letter-spacing:.2em;text-transform:uppercase;color:var(--fg3)}
.pp.held,.pp.held b{color:var(--fg)}
.pp.inst b{color:var(--amber)}
.pg-line{color:var(--fg2);line-height:1.7}

.cs.still *,.cs.still *::before,.cs.still *::after{animation-duration:.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}
@media (prefers-reduced-motion:reduce){
  .tp .tp-num,.tp svg.arc,.tp .tp-st,.tt.on .tt-name{animation:none!important}
}
`;
