import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const LICENSE_KEY =
  process.env.LICENSE_KEY || "DEBAN-AIMAI-2026";

const SERVER_SECRET =
  process.env.SERVER_SECRET || "CHANGE_THIS_SECRET";

const SIGNER_ID =
  process.env.SIGNER_ID || "3bb80515895760f5";

const SIGNING_PRIVATE_KEY = (
  process.env.SIGNING_PRIVATE_KEY || ""
).replace(/\\n/g, "\n");

function b64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(text: string) {
  let s = text.replace(/-/g, "+").replace(/_/g, "/");

  while (s.length % 4) {
    s += "=";
  }

  return Buffer.from(s, "base64");
}

function sha256Hex(input: Buffer | string) {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("hex");
}

function hmac(text: string) {
  return b64url(
    crypto
      .createHmac("sha256", SERVER_SECRET)
      .update(text)
      .digest()
  );
}

function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

function iso(sec: number) {
  return new Date(sec * 1000).toISOString();
}

function normalizeLicense(key: string) {
  return key.trim().toUpperCase();
}

/* -----------------------------
   Challenge ticket
------------------------------ */

function makeChallenge(purpose: string) {
  const id = crypto.randomBytes(16).toString("hex");
  const nonce = randomToken(32);
  const exp = Math.floor(Date.now() / 1000) + 300;

  const raw =
    `${id}|${nonce}|${purpose}|${exp}`;

  const ticket =
    b64url(raw) + "." + hmac(raw);

  return {
    id,
    nonce,
    purpose,
    ticket,
    exp
  };
}

function verifyChallenge(
  challengeId: string,
  nonce: string,
  purpose: string,
  ticket: string
) {
  const parts = String(ticket).split(".");

  if (parts.length !== 2) {
    return false;
  }

  let raw: string;

  try {
    raw = fromB64url(parts[0]).toString("utf8");
  } catch {
    return false;
  }

  const expected = hmac(raw);

  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1]);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return false;
  }

  const fields = raw.split("|");

  if (fields.length !== 4) {
    return false;
  }

  const [id, ticketNonce, ticketPurpose, expText] =
    fields;

  const exp = Number(expText);

  return (
    id === challengeId &&
    ticketNonce === nonce &&
    ticketPurpose === purpose &&
    Number.isFinite(exp) &&
    exp >= Math.floor(Date.now() / 1000)
  );
}

/* -----------------------------
   Device public-key hash
------------------------------ */

function getPublicKeyHash(body: any) {
  /*
    Normal software identity:
    identity.publicKey is Base64 DER/SPKI.
  */

  const pub = body?.identity?.publicKey;

  if (typeof pub === "string" && pub.trim()) {
    try {
      const der = Buffer.from(pub, "base64");
      return sha256Hex(der);
    } catch {
      return null;
    }
  }

  /*
    Attestation fallback:
    first certificate public key.
  */

  const chain = body?.attestation?.certificateChain;

  if (
    Array.isArray(chain) &&
    typeof chain[0] === "string"
  ) {
    try {
      const certBytes = Buffer.from(chain[0], "base64");

      const cert =
        new crypto.X509Certificate(certBytes);

      const der = cert.publicKey.export({
        type: "spki",
        format: "der"
      }) as Buffer;

      return sha256Hex(der);
    } catch {
      return null;
    }
  }

  return null;
}

/* -----------------------------
   Access grant
------------------------------ */

function createGrant(
  sessionId: string,
  publicKeyHash: string,
  deviceBindingHash: string,
  licenseKey: string
) {
  if (!SIGNING_PRIVATE_KEY) {
    throw new Error("SIGNING_KEY_NOT_CONFIGURED");
  }

  const now = Math.floor(Date.now() / 1000);

  /*
    APK accepts a short grant window.
  */

  const issuedAt = now;
  const notBefore = now - 5;
  const expiresAt = now + 300;

  const licenseId =
    sha256Hex(normalizeLicense(licenseKey))
      .slice(0, 16);

  /*
    Exact 14-field layout required by
    AccessGrantVerifier:

    0  AEG
    1  version
    2  signer ID
    3  session ID
    4  key/license ID
    5  device ID
    6  public key hash
    7  reserved
    8  issuedAt
    9  notBefore
    10 expiresAt
    11 capabilities bitmask
    12 capability names
    13 reserved
  */

  const fields = [
    "AEG",                       // 0
    "1",                         // 1
    SIGNER_ID,                   // 2
    sessionId,                   // 3
    licenseId,                   // 4
    deviceBindingHash,           // 5
    publicKeyHash,               // 6
    "",                          // 7
    String(issuedAt),            // 8
    String(notBefore),           // 9
    String(expiresAt),           // 10
    "1",                         // 11
    "carrom-pool",               // 12
    ""                           // 13
  ];

  const payload = fields.join("|");

  const signature = crypto.sign(
    "sha256",
    Buffer.from(payload, "utf8"),
    {
      key: SIGNING_PRIVATE_KEY,
      dsaEncoding: "der"
    }
  );

  const token =
    b64url(Buffer.from(payload, "utf8")) +
    "." +
    b64url(signature);

  return {
    token,
    expiresAt
  };
}

/* -----------------------------
   Stateless refresh token
------------------------------ */

function makeRefreshToken(
  sessionId: string,
  publicKeyHash: string,
  deviceBindingHash: string
) {
  const exp =
    Math.floor(Date.now() / 1000) +
    60 * 60 * 24 * 30;

  const body = JSON.stringify({
    sid: sessionId,
    pkh: publicKeyHash,
    dev: deviceBindingHash,
    exp
  });

  return b64url(body) + "." + hmac(body);
}

function readRefreshToken(token: string) {
  try {
    const [body64, sig] = token.split(".");

    if (!body64 || !sig) {
      return null;
    }

    const body =
      fromB64url(body64).toString("utf8");

    const expected = hmac(body);

    const a = Buffer.from(expected);
    const b = Buffer.from(sig);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return null;
    }

    const obj = JSON.parse(body);

    if (
      !obj.sid ||
      !obj.pkh ||
      !obj.dev ||
      Number(obj.exp) <
        Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return obj;
  } catch {
    return null;
  }
}

/* -----------------------------
   Root
------------------------------ */

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "AIMAI Access API",
    status: "online"
  });
});

/* -----------------------------
   Challenge
------------------------------ */

app.post(
  "/aimai/v2/api/access/challenge",
  (req, res) => {
    const purpose =
      String(req.body?.purpose || "activate");

    if (
      purpose !== "activate" &&
      purpose !== "renew"
    ) {
      return res.status(400).json({
        error: {
          code: "INVALID_PURPOSE",
          message: "Invalid challenge purpose"
        }
      });
    }

    const c = makeChallenge(purpose);

    /*
      APK's post() extracts top-level "data".
    */

    return res.json({
      data: {
        id: c.id,
        nonce: c.nonce,
        purpose: c.purpose,
        ticket: c.ticket,
        softwareEnrollmentAllowed: true
      }
    });
  }
);

/* -----------------------------
   Activate
------------------------------ */

app.post(
  "/aimai/v2/api/access/activate",
  (req, res) => {
    try {
      const body = req.body || {};

      const key = String(body.key || "");
      const deviceBindingHash =
        String(body.deviceBindingHash || "");

      const challengeId =
        String(body.challengeId || "");

      const nonce =
        String(body.nonce || "");

      const ticket =
        String(body.ticket || "");

      if (
        !key ||
        !deviceBindingHash ||
        !challengeId ||
        !nonce ||
        !ticket
      ) {
        return res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "Missing activation fields"
          }
        });
      }

      if (
        normalizeLicense(key) !==
        normalizeLicense(LICENSE_KEY)
      ) {
        return res.status(403).json({
          error: {
            code: "INVALID_KEY",
            message: "License key is invalid"
          }
        });
      }

      if (
        !verifyChallenge(
          challengeId,
          nonce,
          "activate",
          ticket
        )
      ) {
        return res.status(400).json({
          error: {
            code: "CHALLENGE_INVALID",
            message: "Challenge is invalid"
          }
        });
      }

      const publicKeyHash =
        getPublicKeyHash(body);

      if (!publicKeyHash) {
        return res.status(400).json({
          error: {
            code: "IDENTITY_INVALID",
            message: "Device public key is missing"
          }
        });
      }

      const sessionId =
        crypto.randomBytes(32).toString("hex");

      const grant = createGrant(
        sessionId,
        publicKeyHash,
        deviceBindingHash,
        key
      );

      const refreshToken =
        makeRefreshToken(
          sessionId,
          publicKeyHash,
          deviceBindingHash
        );

      const now =
        Math.floor(Date.now() / 1000);

      return res.json({
        data: {
          sessionId,
          refreshToken,

          grant: {
            token: grant.token,
            expiresAt: iso(grant.expiresAt)
          },

          profile: {
            refreshAt: iso(now + 150),
            active: true,
            activatedAt: iso(now),

            expiresAt:
              "2099-12-31T23:59:59Z",

            maskedKey:
              "DEBAN-****-2026",

            sellerName:
              "DEBAN"
          }
        }
      });
    } catch (e) {
      console.error(e);

      return res.status(500).json({
        error: {
          code: "SERVER_ERROR",
          message: "Activation failed"
        }
      });
    }
  }
);

/* -----------------------------
   Renew
------------------------------ */

app.post(
  "/aimai/v2/api/access/renew",
  (req, res) => {
    try {
      const body = req.body || {};

      const challengeId =
        String(body.challengeId || "");

      const nonce =
        String(body.nonce || "");

      const ticket =
        String(body.ticket || "");

      const sessionId =
        String(body.sessionId || "");

      const refreshToken =
        String(body.refreshToken || "");

      if (
        !verifyChallenge(
          challengeId,
          nonce,
          "renew",
          ticket
        )
      ) {
        return res.status(400).json({
          error: {
            code: "CHALLENGE_INVALID",
            message: "Challenge is invalid"
          }
        });
      }

      const refresh =
        readRefreshToken(refreshToken);

      if (
        !refresh ||
        refresh.sid !== sessionId
      ) {
        return res.status(403).json({
          error: {
            code: "REFRESH_INVALID",
            message: "Refresh token is invalid"
          }
        });
      }

      const grant = createGrant(
        refresh.sid,
        refresh.pkh,
        refresh.dev,
        LICENSE_KEY
      );

      const newRefresh =
        makeRefreshToken(
          refresh.sid,
          refresh.pkh,
          refresh.dev
        );

      const now =
        Math.floor(Date.now() / 1000);

      return res.json({
        data: {
          sessionId: refresh.sid,
          refreshToken: newRefresh,

          grant: {
            token: grant.token,
            expiresAt: iso(grant.expiresAt)
          },

          profile: {
            refreshAt: iso(now + 150),
            active: true,
            activatedAt: iso(now),

            expiresAt:
              "2099-12-31T23:59:59Z",

            maskedKey:
              "DEBAN-****-2026",

            sellerName:
              "DEBAN"
          }
        }
      });
    } catch {
      return res.status(500).json({
        error: {
          code: "SERVER_ERROR",
          message: "Renew failed"
        }
      });
    }
  }
);

/* -----------------------------
   Logout
------------------------------ */

app.post(
  "/aimai/v2/api/access/logout",
  (_req, res) => {
    return res.json({
      data: {
        success: true
      }
    });
  }
);

export default app;
