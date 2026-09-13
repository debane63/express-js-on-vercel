import express from "express";
import crypto from "node:crypto";

const app = express();

app.use(express.json());

const LICENSE_KEY = process.env.LICENSE_KEY || "DEBAN-AIMAI-2026";
const SERVER_SECRET =
  process.env.SERVER_SECRET || "CHANGE_THIS_SECRET_NOW_2026";

function b64url(buf: Buffer | string) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hmac(text: string) {
  return b64url(
    crypto.createHmac("sha256", SERVER_SECRET).update(text).digest()
  );
}

function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

/* HEALTH */

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "AIMAI License API",
    status: "online"
  });
});

/* CHALLENGE */

app.post("/aimai/v2/api/access/challenge", (req, res) => {
  const purpose = req.body?.purpose || "activate";

  if (!["activate", "renew"].includes(purpose)) {
    return res.status(400).json({
      error: {
        code: "INVALID_PURPOSE",
        message: "Invalid purpose"
      }
    });
  }

  const id = crypto.randomBytes(16).toString("hex");
  const nonce = randomToken(32);

  const expires = Math.floor(Date.now() / 1000) + 300;

  const ticketPayload = `${id}.${nonce}.${purpose}.${expires}`;

  const ticket =
    b64url(ticketPayload) + "." + hmac(ticketPayload);

  return res.json({
    data: {
      id,
      nonce,
      purpose,
      ticket,
      softwareEnrollmentAllowed: true
    }
  });
});

/* ACTIVATE */

app.post("/aimai/v2/api/access/activate", (req, res) => {
  const {
    key,
    deviceBindingHash,
    challengeId,
    nonce,
    ticket
  } = req.body || {};

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

  if (key !== LICENSE_KEY) {
    return res.status(403).json({
      error: {
        code: "INVALID_KEY",
        message: "License key is invalid"
      }
    });
  }

  try {
    const [payload64, signature] = String(ticket).split(".");

    if (!payload64 || !signature) {
      throw new Error();
    }

    const payload = Buffer.from(
      payload64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString();

    if (hmac(payload) !== signature) {
      throw new Error();
    }

    const [id, ticketNonce, purpose, expString] =
      payload.split(".");

    const exp = Number(expString);

    if (
      id !== challengeId ||
      ticketNonce !== nonce ||
      purpose !== "activate" ||
      !Number.isFinite(exp) ||
      exp < Math.floor(Date.now() / 1000)
    ) {
      throw new Error();
    }
  } catch {
    return res.status(400).json({
      error: {
        code: "CHALLENGE_INVALID",
        message: "Challenge verification failed"
      }
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const grantExp = now + 3600;

  const sessionId = crypto.randomBytes(32).toString("hex");
  const refreshToken = randomToken(48);

  /*
    Temporary grant for parser testing.
    APK may reject this at signature verification stage,
    which is expected until its pinned ECDSA signer is replaced.
  */

  const payload = {
    sessionId,
    deviceBindingHash,
    issuedAt: now,
    expiresAt: grantExp
  };

  const payloadEncoded = b64url(JSON.stringify(payload));
  const signature = hmac(payloadEncoded);

  const grantToken = `${payloadEncoded}.${signature}`;

  return res.json({
    data: {
      sessionId,
      refreshToken,

      grant: {
        token: grantToken,
        expiresAt: new Date(grantExp * 1000).toISOString()
      },

      profile: {
        refreshAt: new Date((now + 1800) * 1000).toISOString(),
        active: true,
        activatedAt: new Date(now * 1000).toISOString(),
        expiresAt: "2099-12-31T23:59:59Z",
        maskedKey: "DEBAN-****-2026",
        sellerName: "DEBAN"
      }
    }
  });
});

/* RENEW */

app.post("/aimai/v2/api/access/renew", (_req, res) => {
  return res.status(501).json({
    error: {
      code: "NOT_IMPLEMENTED",
      message: "Renew not implemented yet"
    }
  });
});

/* LOGOUT */

app.post("/aimai/v2/api/access/logout", (_req, res) => {
  return res.json({
    data: {
      success: true
    }
  });
});

export default app;