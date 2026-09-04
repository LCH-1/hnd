function bytesFromBase64url(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value))
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  if (typeof value !== "string")
    throw new TypeError("패스키 데이터 형식이 올바르지 않습니다.");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1)
    bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

function base64urlFromBytes(value) {
  if (value === null || value === undefined) return null;
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function publicKeyOptions(payload) {
  return (
    payload?.publicKey ||
    payload?.options?.publicKey ||
    payload?.options ||
    payload
  );
}

function credentialDescriptors(items) {
  return Array.isArray(items)
    ? items.map((item) => ({ ...item, id: bytesFromBase64url(item.id) }))
    : items;
}

export function creationOptions(payload) {
  const source = publicKeyOptions(payload);
  if (!source?.challenge || !source?.user?.id)
    throw new TypeError("패스키 생성 옵션이 비어 있습니다.");
  return {
    ...source,
    challenge: bytesFromBase64url(source.challenge),
    user: { ...source.user, id: bytesFromBase64url(source.user.id) },
    excludeCredentials: credentialDescriptors(source.excludeCredentials),
  };
}

export function requestOptions(payload) {
  const source = publicKeyOptions(payload);
  if (!source?.challenge)
    throw new TypeError("패스키 로그인 옵션이 비어 있습니다.");
  return {
    ...source,
    challenge: bytesFromBase64url(source.challenge),
    allowCredentials: credentialDescriptors(source.allowCredentials),
  };
}

export function serializeCredential(credential) {
  if (!credential?.response)
    throw new TypeError("패스키 응답이 비어 있습니다.");
  const response = {
    clientDataJSON: base64urlFromBytes(credential.response.clientDataJSON),
  };

  if ("attestationObject" in credential.response) {
    response.attestationObject = base64urlFromBytes(
      credential.response.attestationObject,
    );
    response.transports = credential.response.getTransports?.() || [];
    response.publicKey = base64urlFromBytes(
      credential.response.getPublicKey?.(),
    );
    response.publicKeyAlgorithm =
      credential.response.getPublicKeyAlgorithm?.() ?? undefined;
    response.authenticatorData = base64urlFromBytes(
      credential.response.getAuthenticatorData?.(),
    );
  } else {
    response.authenticatorData = base64urlFromBytes(
      credential.response.authenticatorData,
    );
    response.signature = base64urlFromBytes(credential.response.signature);
    response.userHandle = base64urlFromBytes(credential.response.userHandle);
  }

  return {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    response,
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
  };
}

function friendlyWebAuthnError(error, action) {
  if (error?.name === "AbortError") {
    return new Error("패스키 인증을 취소했습니다. 다시 시도해 주세요.");
  }
  if (error?.name === "NotAllowedError") {
    return new Error(`${action}이 취소되었거나 시간이 초과되었습니다.`);
  }
  if (error?.name === "InvalidStateError") {
    return new Error("이 기기에 이미 등록된 패스키입니다.");
  }
  if (error?.name === "NotSupportedError") {
    return new Error(
      "이 브라우저 또는 기기는 요청한 패스키 방식을 지원하지 않습니다.",
    );
  }
  if (error?.name === "SecurityError") {
    return new Error(
      "현재 주소에서는 패스키를 사용할 수 없습니다. HTTPS와 서버 도메인을 확인해 주세요.",
    );
  }
  return error instanceof Error
    ? error
    : new Error(`${action}에 실패했습니다.`);
}

export function webAuthnAvailable() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

export async function createPasskey(payload) {
  if (!webAuthnAvailable())
    throw new Error("이 브라우저는 패스키를 지원하지 않습니다.");
  try {
    const credential = await navigator.credentials.create({
      publicKey: creationOptions(payload),
    });
    if (!credential) throw new Error("패스키 응답이 없습니다.");
    return serializeCredential(credential);
  } catch (error) {
    throw friendlyWebAuthnError(error, "패스키 만들기");
  }
}

export async function getPasskey(payload, { signal } = {}) {
  if (!webAuthnAvailable())
    throw new Error("이 브라우저는 패스키를 지원하지 않습니다.");
  try {
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(payload),
      signal,
    });
    if (!credential) throw new Error("패스키 응답이 없습니다.");
    return serializeCredential(credential);
  } catch (error) {
    throw friendlyWebAuthnError(error, "패스키 로그인");
  }
}

export { base64urlFromBytes, bytesFromBase64url };
