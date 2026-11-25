/* Procinity accounts: sign in, sign up, Google, passkeys, profile, password, saved data.
   Talks to /api/* (see _worker.js). Loaded before the main app script. */
(function () {
  "use strict";
  var PX = (window.PX = { u: null, pk: [], cfg: {}, offline: false, synced: false, guest: false });
  PX.isGuest = function () { return !PX.u; };
  var KEYS = ["likes", "follow", "liked", "cart", "cur", "priv", "applied", "cj", "pl", "ship", "pay", "wish", "orders", "rev", "notif", "offered", "dloc", "dres"];
  var $ = function (id) { return document.getElementById(id); };
  var ls = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ---------- helpers ---------- */
  PX.e = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  PX.name = function () { return PX.u ? PX.u.name || PX.u.email : "You"; };
  PX.first = function () { return String(PX.name()).split(/\s+/)[0]; };
  PX.handle = function () { return PX.u ? PX.u.handle || "" : ""; };
  PX.avatar = function () {
    if (PX.u && PX.u.avatar) return '<img src="' + PX.e(PX.u.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block">';
    var n = String(PX.name()).trim().split(/\s+/), i = ((n[0] || "?")[0] + (n.length > 1 ? n[n.length - 1][0] : "")).toUpperCase();
    return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700;color:var(--act);background:rgba(46,255,185,.12)">' + PX.e(i) + "</div>";
  };

  function api(method, path, body) {
    return fetch("/api/" + path, {
      method: method,
      credentials: "include",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && PX.u && path.indexOf("auth/") !== 0 && path.indexOf("passkey/login") !== 0) {
          PX.u = null; PX.synced = false; PX.guest = true;
          showGate("Your session ended. Please sign in again.", "in");
        }
        return { ok: r.ok, status: r.status, d: d };
      });
    }, function () {
      return { ok: false, status: 0, d: { error: "No connection. Check your internet and try again." } };
    });
  }
  PX.api = api;

  var b64 = {
    enc: function (buf) {
      var b = new Uint8Array(buf), s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec: function (s) {
      s = s.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      var r = atob(s), o = new Uint8Array(r.length);
      for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
      return o.buffer;
    }
  };

  /* ---------- styles ---------- */
  var css = document.createElement("style");
  css.textContent =
    "#pxGate{position:fixed;inset:0;z-index:2000;background:var(--bg,#000);color:var(--tx,#f1eee7);overflow:auto;font-family:'Inter Tight',system-ui,-apple-system,sans-serif;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}" +
    "#pxGate .px-w{max-width:400px;margin:0 auto;padding:36px max(20px,env(safe-area-inset-left,0px)) 40px max(20px,env(safe-area-inset-right,0px))}" +
    ".px-logo{font-size:34px;font-weight:600;letter-spacing:.5px;color:var(--act,#2effb9);text-align:center;margin:6px 0 26px}" +
    ".px-h{font-size:24px;font-weight:600;margin:0 0 6px}.px-p{color:var(--mu,#a1a1aa);font-size:15px;line-height:1.45;margin:0 0 18px}" +
    ".px-tabs{display:flex;gap:6px;background:rgba(127,127,127,.12);padding:4px;border-radius:12px;margin-bottom:20px}" +
    ".px-tabs button{flex:1;border:0;background:none;color:var(--mu,#a1a1aa);font:inherit;font-size:15px;font-weight:600;padding:10px;border-radius:9px;cursor:pointer}" +
    ".px-tabs button.on{background:var(--act,#2effb9);color:#000}" +
    ".px-f{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}.px-f label{font-size:13px;color:var(--mu,#a1a1aa)}" +
    ".px-in{width:100%;font:inherit;font-size:16px;padding:12px 14px;border-radius:12px;border:1.5px solid var(--bd,#2b2b2e);background:transparent;color:var(--tx,#f1eee7);outline:none;-webkit-appearance:none;appearance:none}" +
    ".px-in:focus{border-color:var(--ac,#2effb9)}textarea.px-in{resize:vertical;min-height:84px;line-height:1.4}" +
    ".px-pw{position:relative}.px-pw .px-in{padding-right:64px}.px-pw button{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--mu,#a1a1aa);font:inherit;font-size:13px;padding:8px;cursor:pointer}" +
    ".px-btn{width:100%;border:0;border-radius:12px;padding:14px;font:inherit;font-size:16px;font-weight:600;background:var(--act,#2effb9);color:#000;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}" +
    ".px-btn[disabled]{opacity:.55;cursor:default}.px-sec{background:transparent;color:var(--tx,#f1eee7);border:1.5px solid var(--bd,#2b2b2e)}.px-danger{background:#e5484d;color:#fff}" +
    ".px-err{color:#ff6b6b;font-size:14px;line-height:1.4;min-height:0;margin:0 0 12px}.px-ok{color:var(--act,#2effb9);font-size:14px;margin:0 0 12px}" +
    ".px-link{border:0;background:none;color:var(--ac,#2effb9);font:inherit;font-size:14px;padding:4px 0;cursor:pointer}" +
    ".px-or{display:flex;align-items:center;gap:12px;color:var(--mu,#a1a1aa);font-size:13px;margin:18px 0}.px-or:before,.px-or:after{content:'';flex:1;height:1px;background:var(--bd,#2b2b2e)}" +
    ".px-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}.px-chips button{border:1.5px solid var(--bd,#2b2b2e);background:none;color:var(--tx,#f1eee7);font:inherit;font-size:14px;padding:7px 12px;border-radius:99px;cursor:pointer}" +
    ".px-spin{width:18px;height:18px;border:2.5px solid rgba(0,0,0,.25);border-top-color:#000;border-radius:50%;animation:pxs .7s linear infinite}@keyframes pxs{to{transform:rotate(360deg)}}" +
    "#pxSheet{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.62);display:flex;align-items:flex-end;justify-content:center;font-family:'Inter Tight',system-ui,-apple-system,sans-serif}" +
    "#pxSheet .px-pan{width:100%;max-width:520px;max-height:92%;overflow:auto;background:var(--bg,#000);color:var(--tx,#f1eee7);border:1px solid var(--bd,#2b2b2e);border-bottom:0;border-radius:20px 20px 0 0;padding:20px max(18px,env(safe-area-inset-left,0px)) calc(24px + env(safe-area-inset-bottom,0px)) max(18px,env(safe-area-inset-right,0px))}" +
    ".px-pk{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--bd,#2b2b2e);font-size:15px}.px-pk span{flex:1;min-width:0}.px-pk small{display:block;color:var(--mu,#a1a1aa);font-size:12px}" +
    ".px-av{width:88px;height:88px;border-radius:50%;overflow:hidden;background:#1a1a1c;flex:none}" +
    "@media (prefers-reduced-motion:reduce){.px-spin{animation:none}}";
  document.head.appendChild(css);

  /* ---------- sign-in screen ---------- */
  var gate = null, mode = "in", gisReady = false, pendingFn = null, pendingMsg = "";
  function ensureGate() {
    if (gate && gate.isConnected) return gate;
    gate = document.createElement("div");
    gate.id = "pxGate";
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-label", "Sign in to Procinity");
    (document.body || document.documentElement).appendChild(gate);
    return gate;
  }
  function hideGate() { if (gate) { gate.remove(); gate = null; } }
  PX.clearPending = function () { pendingFn = null; pendingMsg = ""; };
  PX.requireAuth = function (msg, fn, which) {
    if (PX.u) {
      if (typeof fn === "function") fn();
      return true;
    }
    showGate(msg || "Sign in or create an account to continue.", which || "in", {
      onAuthed: typeof fn === "function" ? fn : null
    });
    return false;
  };
  function splash() {
    ensureGate().innerHTML = '<div class="px-w" style="padding-top:34vh"><div class="px-logo">Procinity</div></div>';
  }
  function busy(btn, on, label) {
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="px-spin"></span>' : label;
  }
  function recent() { return ls.get("px_recent") || []; }
  function remember(u) {
    var r = recent().filter(function (x) { return x.email !== u.email; });
    r.unshift({ email: u.email, name: u.name || "" });
    ls.set("px_recent", r.slice(0, 4));
  }

  function showGate(msg, which, opts) {
    opts = opts || {};
    if (which) mode = which;
    if (opts.preservePending) {
      if (!msg && pendingMsg) msg = pendingMsg;
    } else {
      pendingFn = typeof opts.onAuthed === "function" ? opts.onAuthed : null;
      pendingMsg = msg || "";
    }
    var g = ensureGate();
    var up = mode === "up";
    var rec = recent();
    var guestLabel = pendingFn ? "Continue browsing" : "Browse as guest";
    g.innerHTML =
      '<div class="px-w"><div class="px-logo">Procinity</div>' +
      '<div class="px-tabs" role="tablist"><button type="button" id="pxTi" class="' + (up ? "" : "on") + '" role="tab">Sign in</button><button type="button" id="pxTu" class="' + (up ? "on" : "") + '" role="tab">Create account</button></div>' +
      (msg ? '<p class="px-ok" style="color:var(--mu)" id="pxMsg">' + PX.e(msg) + "</p>" : "") +
      (!up && rec.length ? '<div class="px-chips" id="pxRec" aria-label="Recent accounts">' + rec.map(function (r, i) { return '<button type="button" data-i="' + i + '">' + PX.e(r.name || r.email) + "</button>"; }).join("") + "</div>" : "") +
      '<form id="pxForm" novalidate>' +
      (up ? '<div class="px-f"><label for="pxN">Full name</label><input class="px-in" id="pxN" autocomplete="name" maxlength="60"></div>' : "") +
      '<div class="px-f"><label for="pxE">Email</label><input class="px-in" id="pxE" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="px-f"><label for="pxP">Password' + (up ? " (8+ characters)" : "") + '</label><div class="px-pw"><input class="px-in" id="pxP" type="password" autocomplete="' + (up ? "new-password" : "current-password") + '"><button type="button" id="pxShow">Show</button></div></div>' +
      '<p class="px-err" id="pxErr" role="alert"></p>' +
      '<button class="px-btn" id="pxGo" type="submit">' + (up ? "Create account" : "Sign in") + "</button>" +
      (up ? "" : '<div style="text-align:center;margin-top:10px"><button type="button" class="px-link" id="pxForgot">Forgot password?</button></div>') +
      "</form>" +
      '<div class="px-or">or</div>' +
      '<div id="pxG" style="display:flex;justify-content:center;min-height:0"></div>' +
      (window.PublicKeyCredential ? '<button class="px-btn px-sec" id="pxPk" type="button" style="margin-top:10px">Sign in with a passkey</button>' : "") +
      '<button class="px-btn px-sec" id="pxGuest" type="button" style="margin-top:10px">' + guestLabel + "</button>" +
      '<p class="px-p" style="font-size:12px;text-align:center;margin:20px 0 0">By continuing you agree to the Terms of service and Community guidelines.</p></div>';
    $("pxTi").onclick = function () { showGate(pendingMsg, "in", { preservePending: true }); };
    $("pxTu").onclick = function () { showGate(pendingMsg, "up", { preservePending: true }); };
    $("pxShow").onclick = function () {
      var p = $("pxP"), s = p.type === "password";
      p.type = s ? "text" : "password"; this.textContent = s ? "Hide" : "Show";
    };
    var rc = $("pxRec");
    if (rc) rc.onclick = function (e) {
      var i = e.target.getAttribute("data-i"); if (i == null) return;
      $("pxE").value = rec[+i].email; $("pxP").focus();
    };
    var fg = $("pxForgot"); if (fg) fg.onclick = showForgot;
    $("pxForm").onsubmit = function (ev) {
      ev.preventDefault();
      var err = $("pxErr"), btn = $("pxGo"), email = $("pxE").value.trim(), pw = $("pxP").value;
      err.textContent = "";
      if (!email) { err.textContent = "Enter your email address."; $("pxE").focus(); return; }
      if (!pw) { err.textContent = "Enter your password."; $("pxP").focus(); return; }
      if (up && pw.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
      busy(btn, true);
      api("POST", up ? "auth/signup" : "auth/login", up ? { email: email, password: pw, name: $("pxN").value } : { email: email, password: pw }).then(function (r) {
        if (r.ok) return signedIn(r.d, up);
        busy(btn, false, up ? "Create account" : "Sign in");
        err.textContent = r.d.error || (up ? "Could not create account." : "Could not sign in.");
      });
    };
    var pk = $("pxPk"); if (pk) pk.onclick = passkeySignIn;
    var gs = $("pxGuest");
    if (gs) gs.onclick = function () {
      PX.clearPending();
      ls.set("px_guest", 1);
      PX.guest = true;
      hideGate();
      if (window.render) { try { render(); } catch (e) { console.error(e); } }
    };
    mountGoogle();
    var first = $(up ? "pxN" : "pxE"); if (first && !("ontouchstart" in window)) first.focus();
  }
  PX.showGate = showGate;

  function mountGoogle() {
    var id = PX.cfg.googleClientId, box = $("pxG");
    if (!id || !box) return;
    function draw() {
      var b = $("pxG"); if (!b || !window.google || !google.accounts) return;
      if (!gisReady) {
        google.accounts.id.initialize({
          client_id: id,
          ux_mode: "popup",
          callback: function (resp) {
            var err = $("pxErr"); if (err) err.textContent = "";
            api("POST", "auth/google", { credential: resp.credential }).then(function (r) {
              if (r.ok) signedIn(r.d); else if ($("pxErr")) $("pxErr").textContent = r.d.error || "Google sign-in failed.";
            });
          }
        });
        gisReady = true;
      }
      b.innerHTML = "";
      google.accounts.id.renderButton(b, { theme: "filled_black", size: "large", shape: "pill", text: mode === "up" ? "signup_with" : "signin_with", width: Math.min(360, (gate && gate.clientWidth || 360) - 40) });
    }
    if (window.google && google.accounts) return draw();
    if (document.getElementById("pxGis")) { document.getElementById("pxGis").addEventListener("load", draw); return; }
    var s = document.createElement("script");
    s.id = "pxGis"; s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = draw;
    document.head.appendChild(s);
  }

  function showForgot() {
    var g = ensureGate(), email = ($("pxE") && $("pxE").value.trim()) || "";
    if (!PX.cfg.emailEnabled) {
      g.innerHTML = '<div class="px-w"><div class="px-logo">Procinity</div><h1 class="px-h">Reset your password</h1><p class="px-p">Password reset by email is not available yet. Sign in with Google or a passkey, or contact support.</p><button class="px-btn px-sec" id="pxBk" type="button">Back to sign in</button></div>';
      $("pxBk").onclick = function () { showGate(pendingMsg, "in", { preservePending: true }); };
      return;
    }
    g.innerHTML =
      '<div class="px-w"><div class="px-logo">Procinity</div><h1 class="px-h">Reset your password</h1><p class="px-p" id="pxFp">Enter your email and we will send you a 6-digit code.</p>' +
      '<form id="pxF1" novalidate><div class="px-f"><label for="pxE2">Email</label><input class="px-in" id="pxE2" type="email" inputmode="email" autocomplete="email" autocapitalize="off" value="' + PX.e(email) + '"></div>' +
      '<div id="pxStep2" hidden><div class="px-f"><label for="pxC">6-digit code</label><input class="px-in" id="pxC" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
      '<div class="px-f"><label for="pxNp">New password (8+ characters)</label><div class="px-pw"><input class="px-in" id="pxNp" type="password" autocomplete="new-password"><button type="button" id="pxSh2">Show</button></div></div></div>' +
      '<p class="px-err" id="pxErr" role="alert"></p><button class="px-btn" id="pxGo" type="submit">Send code</button></form>' +
      '<div style="text-align:center;margin-top:14px"><button type="button" class="px-link" id="pxBk">Back to sign in</button></div></div>';
    $("pxBk").onclick = function () { showGate(pendingMsg, "in", { preservePending: true }); };
    $("pxSh2").onclick = function () { var p = $("pxNp"), s = p.type === "password"; p.type = s ? "text" : "password"; this.textContent = s ? "Hide" : "Show"; };
    var step = 1;
    $("pxF1").onsubmit = function (ev) {
      ev.preventDefault();
      var err = $("pxErr"), btn = $("pxGo"); err.textContent = "";
      var em = $("pxE2").value.trim();
      if (step === 1) {
        busy(btn, true);
        api("POST", "auth/forgot", { email: em }).then(function (r) {
          if (!r.ok) { busy(btn, false, "Send code"); err.textContent = r.d.error || "Could not send the code."; return; }
          step = 2; $("pxStep2").hidden = false; $("pxE2").readOnly = true;
          $("pxFp").textContent = "If an account exists for " + em + ", a code is on its way. It expires in 15 minutes.";
          busy(btn, false, "Reset password"); $("pxC").focus();
        });
      } else {
        busy(btn, true);
        api("POST", "auth/reset", { email: em, code: $("pxC").value, password: $("pxNp").value }).then(function (r) {
          if (!r.ok) { busy(btn, false, "Reset password"); err.textContent = r.d.error || "Could not reset your password."; return; }
          showGate("Password updated. Sign in with your new password.", "in", { preservePending: true });
          $("pxE").value = em;
        });
      }
    };
  }

  function passkeySignIn() {
    var err = $("pxErr"), btn = $("pxPk"); if (err) err.textContent = "";
    busy(btn, true);
    var reset = function (m) { busy(btn, false, "Sign in with a passkey"); if (m && $("pxErr")) $("pxErr").textContent = m; };
    api("POST", "passkey/login-options").then(function (o) {
      if (!o.ok) return reset(o.d.error || "Could not start passkey sign-in.");
      return navigator.credentials.get({ publicKey: { challenge: b64.dec(o.d.challenge), rpId: o.d.rpId, timeout: 60000, userVerification: "preferred", allowCredentials: [] } }).then(function (c) {
        var r = c.response;
        return api("POST", "passkey/login", { id: c.id, response: { clientDataJSON: b64.enc(r.clientDataJSON), authenticatorData: b64.enc(r.authenticatorData), signature: b64.enc(r.signature) } }).then(function (x) {
          if (x.ok) signedIn(x.d); else reset(x.d.error || "Passkey sign-in failed.");
        });
      });
    }).catch(function (e) {
      reset(e && e.name === "NotAllowedError" ? "Passkey sign-in was cancelled. Try again, or use your email and password." : "This device could not use a passkey.");
    });
  }

  /* ---------- session + saved data ---------- */
  var lastSnap = "";
  function snap() {
    var o = {};
    if (window.S) {
      if (S.cur === undefined && S.pick && S.pick.Currency) S.cur = S.pick.Currency;
      KEYS.forEach(function (k) { if (S[k] !== undefined) o[k] = S[k]; });
    }
    return JSON.stringify(o);
  }
  function applyState(st) {
    if (!window.S || !st) return;
    KEYS.forEach(function (k) { if (k in st) S[k] = st[k]; });
    if (S.cur) {
      if (!S.pick || typeof S.pick !== "object") S.pick = {};
      S.pick.Currency = S.cur;
    } else if (S.pick && S.pick.Currency) {
      S.cur = S.pick.Currency;
    }
  }
  function signedIn(d, isNew) {
    var fn = pendingFn;
    pendingFn = null;
    pendingMsg = "";
    ls.del("px_guest"); PX.guest = false;
    PX.u = d.user; PX.pk = d.passkeys || []; PX.offline = false;
    ls.set("px_user", { id: d.user.id, name: d.user.name, email: d.user.email, handle: d.user.handle });
    remember(d.user);
    applyState(d.state);
    if (window._biz) {
      window._biz.my = null; window._biz.myUid = null; window._biz.dir = null;
    }
    if (window._prod) {
      window._prod.my = null; window._prod.myUid = null;
      window._prod.biz = null; window._prod.bizUid = null;
      window._prod.pub = null;
    }
    lastSnap = snap(); PX.synced = true;
    hideGate();
    if (window.render) { try { render(); } catch (e) { console.error(e); } }
    if (typeof PX.onAuthRefresh === "function") {
      try { PX.onAuthRefresh(); } catch (e) { console.error(e); }
    }
    if (isNew && window.toast) toast("Welcome to Procinity");
    if (typeof fn === "function" && PX.u) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
  setInterval(function () {
    if (!PX.u || PX.offline || !PX.synced) return;
    var s = snap(); if (s === lastSnap) return;
    var prev = lastSnap; lastSnap = s;
    api("PUT", "state", { state: JSON.parse(s) }).then(function (r) { if (!r.ok) lastSnap = prev; });
  }, 1500);
  function flush() {
    if (!PX.u || PX.offline || !PX.synced) return;
    var s = snap(); if (s === lastSnap) return; lastSnap = s;
    try { fetch("/api/state", { method: "PUT", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ state: JSON.parse(s) }) }); } catch (e) {}
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });

  PX.logout = function () {
    PX.clearPending();
    api("POST", "auth/logout").then(function () { ls.del("px_user"); ls.del("px_guest"); location.reload(); });
  };

  /* ---------- dialogs ---------- */
  function sheet(html) {
    var old = $("pxSheet"); if (old) old.remove();
    var o = document.createElement("div");
    o.id = "pxSheet"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
    o.innerHTML = '<div class="px-pan">' + html + "</div>";
    document.body.appendChild(o);
    var close = function () { o.remove(); document.removeEventListener("keydown", esc); };
    var esc = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    o.addEventListener("mousedown", function (e) { if (e.target === o) close(); });
    o.close = close;
    return o;
  }
  function field(id, label, type, val, extra) {
    var inner = type === "textarea"
      ? '<textarea class="px-in" id="' + id + '" ' + (extra || "") + ">" + PX.e(val || "") + "</textarea>"
      : '<input class="px-in" id="' + id + '" type="' + type + '" value="' + PX.e(val || "") + '" ' + (extra || "") + ">";
    return '<div class="px-f"><label for="' + id + '">' + label + "</label>" + inner + "</div>";
  }
  function refreshPages() {
    var p = $("profilePage"), a = $("accountPage");
    if (p) { p.remove(); window.openAccount && window.openAccount(); }
    if (a) { a.remove(); window.openShopInfo && window.openShopInfo(); }
    if (window.render) try { render(); } catch (e) {}
  }
  function done(o, msg) { o.close(); if (msg && window.toast) toast(msg); refreshPages(); }

  function pickPhoto(cb, opts) {
    opts = opts || {};
    var i = document.createElement("input");
    i.type = "file"; i.accept = "image/*";
    i.onchange = function () {
      var f = i.files[0]; if (!f) return;
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        var maxSide = opts.size || 256, q = opts.quality || 0.85;
        var c = document.createElement("canvas");
        if (opts.fit) {
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        } else {
          c.width = c.height = maxSide;
          var m = Math.min(img.width, img.height);
          c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, maxSide, maxSide);
        }
        URL.revokeObjectURL(url);
        var out = c.toDataURL("image/jpeg", q);
        while (out.length > 155 * 1024 && q > 0.45) {
          q -= 0.1;
          out = c.toDataURL("image/jpeg", q);
        }
        if (out.length > 160 * 1024) {
          if (window.toast) toast("That photo is too large. Pick a smaller one.");
          return;
        }
        cb(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); if (window.toast) toast("That file is not a photo we can use"); };
      img.src = url;
    };
    i.click();
  }
  PX.pickPhoto = pickPhoto;

  PX.editProfile = function () {
    var u = PX.u, photo = null;
    var o = sheet(
      '<h2 class="px-h">Edit profile</h2>' +
      '<div style="display:flex;align-items:center;gap:16px;margin:12px 0 18px"><div class="px-av" id="pxAv">' + PX.avatar() + '</div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start"><button type="button" class="px-link" id="pxPh">Change photo</button><button type="button" class="px-link" id="pxRm" style="color:var(--mu)">Remove photo</button></div></div>' +
      '<form id="pxEf" novalidate>' +
      field("pxfN", "Name", "text", u.name, 'maxlength="60" autocomplete="name"') +
      field("pxfH", "Username", "text", u.handle, 'maxlength="24" autocapitalize="off" spellcheck="false"') +
      field("pxfT", "Headline", "text", u.headline, 'maxlength="80" placeholder="What you do"') +
      field("pxfB", "Bio", "textarea", u.bio, 'maxlength="300"') +
      field("pxfP", "Phone number", "tel", u.phone, 'autocomplete="tel"') +
      field("pxfL", "Location", "text", u.location, 'maxlength="80" autocomplete="address-level2"') +
      '<p class="px-err" id="pxErr" role="alert"></p><button class="px-btn" id="pxGo" type="submit">Save</button></form>'
    );
    var av = o.querySelector("#pxAv");
    function showAv(src) { av.innerHTML = src ? '<img src="' + PX.e(src) + '" alt="" style="width:100%;height:100%;object-fit:cover">' : PX.avatar().replace(/<img[^>]*>/, ""); }
    o.querySelector("#pxPh").onclick = function () { pickPhoto(function (d) { photo = d; showAv(d); }); };
    o.querySelector("#pxRm").onclick = function () { photo = ""; var keep = PX.u.avatar; PX.u.avatar = ""; av.innerHTML = PX.avatar(); PX.u.avatar = keep; };
    o.querySelector("#pxEf").onsubmit = function (ev) {
      ev.preventDefault();
      var v = function (id) { return o.querySelector("#" + id).value; }, body = {};
      var map = { name: "pxfN", handle: "pxfH", headline: "pxfT", bio: "pxfB", phone: "pxfP", location: "pxfL" };
      Object.keys(map).forEach(function (k) { var nv = v(map[k]).trim(); if (nv !== (u[k] || "")) body[k] = nv; });
      if (photo !== null) body.avatar = photo;
      if (!Object.keys(body).length) return o.close();
      var btn = o.querySelector("#pxGo"); busy(btn, true);
      api("PATCH", "me", body).then(function (r) {
        if (!r.ok) { busy(btn, false, "Save"); o.querySelector("#pxErr").textContent = r.d.error || "Could not save."; return; }
        PX.u = r.d.user; ls.set("px_user", { id: PX.u.id, name: PX.u.name, email: PX.u.email, handle: PX.u.handle });
        done(o, "Profile saved");
      });
    };
  };
  PX.changePhoto = function () {
    pickPhoto(function (d) {
      api("PATCH", "me", { avatar: d }).then(function (r) {
        if (!r.ok) return window.toast && toast(r.d.error || "Could not save the photo");
        PX.u = r.d.user; refreshPages(); if (window.toast) toast("Photo updated");
      });
    });
  };

  PX.emailSheet = function () {
    if (!PX.u.hasPassword) {
      var s = sheet('<h2 class="px-h">Email</h2><p class="px-p">Your email is <b>' + PX.e(PX.u.email) + '</b>. To change it, first create a password under Change password.</p><button class="px-btn px-sec" id="pxX" type="button">Close</button>');
      s.querySelector("#pxX").onclick = s.close; return;
    }
    var o = sheet('<h2 class="px-h">Change email</h2><form id="pxEm" novalidate>' + field("pxeE", "New email", "email", "", 'autocomplete="email" autocapitalize="off"') + field("pxeP", "Current password", "password", "", 'autocomplete="current-password"') + '<p class="px-err" id="pxErr" role="alert"></p><button class="px-btn" id="pxGo" type="submit">Save email</button></form>');
    o.querySelector("#pxEm").onsubmit = function (ev) {
      ev.preventDefault(); var btn = o.querySelector("#pxGo"); busy(btn, true);
      api("POST", "me/email", { email: o.querySelector("#pxeE").value, password: o.querySelector("#pxeP").value }).then(function (r) {
        if (!r.ok) { busy(btn, false, "Save email"); o.querySelector("#pxErr").textContent = r.d.error || "Could not change email."; return; }
        PX.u = r.d.user; done(o, "Email updated");
      });
    };
  };

  PX.passwordSheet = function () {
    var has = PX.u.hasPassword;
    var o = sheet('<h2 class="px-h">' + (has ? "Change password" : "Create a password") + "</h2>" + (has ? "" : '<p class="px-p">Add a password so you can also sign in with your email.</p>') +
      '<form id="pxPf" novalidate>' + (has ? field("pxpC", "Current password", "password", "", 'autocomplete="current-password"') : "") +
      field("pxpN", "New password (8+ characters)", "password", "", 'autocomplete="new-password"') + field("pxpM", "Confirm new password", "password", "", 'autocomplete="new-password"') +
      '<p class="px-err" id="pxErr" role="alert"></p><button class="px-btn" id="pxGo" type="submit">Save password</button></form>');
    o.querySelector("#pxPf").onsubmit = function (ev) {
      ev.preventDefault(); var err = o.querySelector("#pxErr"), n = o.querySelector("#pxpN").value;
      if (n.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
      if (n !== o.querySelector("#pxpM").value) { err.textContent = "The two passwords don't match."; return; }
      var btn = o.querySelector("#pxGo"); busy(btn, true);
      api("POST", "me/password", { current: has ? o.querySelector("#pxpC").value : undefined, next: n }).then(function (r) {
        if (!r.ok) { busy(btn, false, "Save password"); err.textContent = r.d.error || "Could not change password."; return; }
        PX.u.hasPassword = true; done(o, "Password updated. Other devices were signed out.");
      });
    };
  };

  PX.passkeySheet = function () {
    function body() {
      var list = PX.pk.map(function (p) {
        return '<div class="px-pk"><span>' + PX.e(p.label || "Passkey") + "<small>Added " + new Date(p.created_at).toLocaleDateString() + '</small></span><button class="px-link" data-id="' + PX.e(p.id) + '" style="color:#ff6b6b">Remove</button></div>';
      }).join("");
      return '<h2 class="px-h">Passkeys</h2><p class="px-p">Sign in with your face, fingerprint or device PIN. No password needed.</p>' +
        (list || '<p class="px-p">You have no passkeys yet.</p>') +
        '<p class="px-err" id="pxErr" role="alert" style="margin-top:12px"></p>' +
        (window.PublicKeyCredential ? '<button class="px-btn" id="pxNew" type="button">Create a passkey on this device</button>' : '<p class="px-p">This browser does not support passkeys.</p>');
    }
    var o = sheet(body());
    function bind() {
      var nb = o.querySelector("#pxNew");
      if (nb) nb.onclick = function () { PX.createPasskey(function (ok, msg) { if (ok) { o.querySelector(".px-pan").innerHTML = body(); bind(); refreshPages(); } else o.querySelector("#pxErr").textContent = msg || ""; }); };
      Array.prototype.forEach.call(o.querySelectorAll("[data-id]"), function (b) {
        b.onclick = function () {
          api("DELETE", "passkey/" + encodeURIComponent(b.getAttribute("data-id"))).then(function (r) {
            if (r.ok) { PX.pk = r.d.passkeys; o.querySelector(".px-pan").innerHTML = body(); bind(); refreshPages(); }
          });
        };
      });
    }
    bind();
  };
  PX.createPasskey = function (cb) {
    api("POST", "passkey/register-options").then(function (o) {
      if (!o.ok) return cb(false, o.d.error);
      var d = o.d;
      return navigator.credentials.create({
        publicKey: {
          challenge: b64.dec(d.challenge), rp: d.rp,
          user: { id: b64.dec(d.user.id), name: d.user.name, displayName: d.user.displayName },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
          excludeCredentials: d.exclude.map(function (id) { return { type: "public-key", id: b64.dec(id) }; }),
          timeout: 60000, attestation: "none"
        }
      }).then(function (c) {
        var r = c.response;
        if (!r.getPublicKey) return cb(false, "This browser can't create passkeys for Procinity.");
        var label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone or iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : /Mac/.test(navigator.userAgent) ? "Mac" : /Windows/.test(navigator.userAgent) ? "Windows PC" : "This device";
        return api("POST", "passkey/register", { id: c.id, label: label, response: { clientDataJSON: b64.enc(r.clientDataJSON), publicKey: b64.enc(r.getPublicKey()), alg: r.getPublicKeyAlgorithm() } }).then(function (x) {
          if (x.ok) { PX.pk = x.d.passkeys; cb(true); } else cb(false, x.d.error);
        });
      });
    }).catch(function (e) {
      cb(false, e && e.name === "NotAllowedError" ? "Passkey setup was cancelled." : e && e.name === "InvalidStateError" ? "A passkey for this account already exists on this device." : "This device could not create a passkey.");
    });
  };

  PX.switchSheet = function () {
    var o = sheet('<h2 class="px-h">Switch account</h2><p class="px-p">You will be signed out of <b>' + PX.e(PX.u.email) + "</b> on this device so you can sign in with another account. Your data stays saved on the account.</p>" +
      '<button class="px-btn" id="pxGo" type="button">Sign out and switch</button><button class="px-btn px-sec" id="pxX" type="button" style="margin-top:10px">Cancel</button>');
    o.querySelector("#pxX").onclick = o.close;
    o.querySelector("#pxGo").onclick = function () { busy(this, true); PX.logout(); };
  };

  PX.deleteSheet = function () {
    var has = PX.u.hasPassword;
    var o = sheet('<h2 class="px-h">Delete account</h2><p class="px-p">This permanently deletes your account, profile and saved data. It cannot be undone.</p><form id="pxDf" novalidate>' +
      (has ? field("pxdP", "Enter your password to confirm", "password", "", 'autocomplete="current-password"') : field("pxdP", "Type DELETE to confirm", "text", "", 'autocapitalize="characters" autocomplete="off"')) +
      '<p class="px-err" id="pxErr" role="alert"></p><button class="px-btn px-danger" id="pxGo" type="submit">Delete my account</button><button class="px-btn px-sec" id="pxX" type="button" style="margin-top:10px">Cancel</button></form>');
    o.querySelector("#pxX").onclick = o.close;
    o.querySelector("#pxDf").onsubmit = function (ev) {
      ev.preventDefault(); var btn = o.querySelector("#pxGo"), v = o.querySelector("#pxdP").value; busy(btn, true);
      api("DELETE", "me", has ? { password: v } : { confirm: v }).then(function (r) {
        if (!r.ok) { busy(btn, false, "Delete my account"); o.querySelector("#pxErr").textContent = r.d.error || "Could not delete the account."; return; }
        ls.del("px_user"); ls.set("px_recent", recent().filter(function (x) { return x.email !== PX.u.email; })); location.reload();
      });
    };
  };

  /* ---------- wire the existing Account pages ---------- */
  PX.wire = function (o) {
    if (!o || !PX.u) return;
    var go = {
      name: PX.editProfile, phone: PX.editProfile, loc: PX.editProfile,
      email: PX.emailSheet, pw: PX.passwordSheet, pk: PX.passkeySheet,
      sw: PX.switchSheet, so: PX.logout, del: PX.deleteSheet,
      cur: function () { o.remove(); window.goMe && goMe("ShopCur"); },
      ship: function () { o.remove(); window.goMe && goMe("ShipAddr"); }
    };
    Array.prototype.forEach.call(o.querySelectorAll("[data-a]"), function (r) {
      var f = go[r.getAttribute("data-a")];
      if (f) r.onclick = function (e) { e.stopPropagation(); f(); };
    });
    ["pgEdit", "acEdit"].forEach(function (id) { var b = o.querySelector("#" + id); if (b) b.onclick = PX.editProfile; });
    var av = o.querySelector("#acAv"); if (av) av.onclick = PX.changePhoto;
    var bn = o.querySelector("#pkBanner");
    if (bn) {
      if (PX.pk.length) bn.remove();
      else bn.addEventListener("click", function (e) {
        if (e.target.closest("#pkX")) return;
        PX.createPasskey(function (ok, msg) { if (ok) { bn.remove(); if (window.toast) toast("Passkey created"); } else if (msg && window.toast) toast(msg); });
      });
    }
  };
  function hook() {
    [["openAccount", "profilePage"], ["openShopInfo", "accountPage"]].forEach(function (p) {
      var f = window[p[0]]; if (typeof f !== "function" || f._px) return;
      var w = function () { var r = f.apply(this, arguments); try { PX.wire($(p[1])); } catch (e) { console.error(e); } return r; };
      w._px = 1; window[p[0]] = w;
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook); else hook();

  /* ---------- boot ---------- */
  if (document.body) splash(); else document.addEventListener("DOMContentLoaded", splash);
  var domReady = new Promise(function (res) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", res); else res(); });
  Promise.all([domReady, fetch("/api/config").then(function (r) { return r.json(); }).catch(function () { return {}; }), api("GET", "me")]).then(function (a) {
    PX.cfg = a[1] || {};
    var r = a[2];
    if (r.ok && r.d && r.d.user) return signedIn(r.d);
    if (r.status === 0) {
      var c = ls.get("px_user");
      if (c) { PX.u = { id: c.id, name: c.name, email: c.email, handle: c.handle, headline: "", bio: "", phone: "", location: "", avatar: "" }; PX.offline = true; hideGate(); if (window.toast) toast("You're offline. Changes won't be saved."); return; }
    }
    if (r.status !== 0) {
      PX.guest = true;
      hideGate();
      if (window.render) { try { render(); } catch (e) { console.error(e); } }
      return;
    }
    showGate("You're offline. Connect to the internet to sign in.", "in");
  });
})();
