// API client: forwards the iframe token from the URL into x-usernode-token.
const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('token') || '';

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-usernode-token': TOKEN,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('You need to sign in through Homeroom');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  patch: (p, body) => request(p, { method: 'PATCH', body: JSON.stringify(body || {}) }),
};

async function signMessage(address, message) {
  if (window.ethereum) {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    return window.ethereum.request({ method: 'personal_sign', params: [message, address] });
  }
  throw new Error('No browser wallet found. Install MetaMask or open Questora in a wallet browser.');
}

window.QuestoraAPI = { api, signMessage, TOKEN };
