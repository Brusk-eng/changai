const IS_DEV = import.meta.env.DEV
export const PIPELINE_TIMEOUT_MS = 180000
const POLL_START_MS = 5000
const POLL_INTERVAL_MS = 3000

// Plain fetch instead of frappe.call: frappe.call pops up "Request Timed Out" dialogs on
// gateway errors even though the answer can still arrive through polling
async function parseMethodResponse(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.ok && body) return body.message
  const err = new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim())
  err.status = res.status
  // only Frappe error responses carry exception/_server_messages; proxies return HTML
  if (body && (body.exception || body._server_messages || body.exc_type)) err.responseJSON = body
  throw err
}

function postMethod(method, args, signal) {
  return fetch(`/api/method/${method}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': window.frappe?.csrf_token || '',
    },
    body: JSON.stringify(args),
    signal,
  }).then(parseMethodResponse)
}

function getMethod(method, args) {
  const query = new URLSearchParams(args).toString()
  return fetch(`/api/method/${method}?${query}`, {
    headers: { Accept: 'application/json' },
  }).then(parseMethodResponse)
}

export const API = {
  PIPELINE: 'changai.changai.api.v2.text2sql_pipeline_v2.run_text2sql_pipeline',
  PIPELINE_RESULT: 'changai.changai.api.v2.text2sql_pipeline_v2.get_pipeline_result',
  SUPPORT: 'changai.changai.api.v2.helpdesk_api.support_bot',
  SETTINGS: 'changai.changai.api.v2.schema_utils.get_frontend_settings',
  TTS: 'changai.changai.api.v2.tts.synthesize_tts',
}

export function frappeCall(method, args = {}, mode = 'actual') {
  if (mode === 'test') {
    return Promise.resolve({ Bot: `[TEST MODE] ${JSON.stringify(args)}` })
  }

  if (!window.frappe || !window.frappe.call) {
    if (IS_DEV) {
      console.warn('[DEV] frappe.call not available in actual mode')
    }
    return Promise.reject(new Error('Frappe API is unavailable in actual mode.'))
  }

  return new Promise((resolve, reject) => {
    window.frappe.call({
      method,
      args,
      callback(r) {
        resolve(r.message)
      },
      error(err) {
        reject(err)
      },
    })
  })
}

export function runPipeline(userQuestion, chatId, mode = 'actual', requestId = null, sendNonErptoAI) {
  return frappeCall(API.PIPELINE, {
    user_question: userQuestion,
    chat_id: chatId,
    request_id: requestId,
    sendNonErptoAI: sendNonErptoAI,
  }, mode)
}
export function runPipelineCancelable(userQuestion, chatId, mode = 'actual', requestId = null, sendNonErptoAI, { onConnectionLost } = {}) {
  if (mode === 'test') {
    return {
      promise: Promise.resolve({
        Bot: `[TEST MODE] ${JSON.stringify({
          user_question: userQuestion,
          chat_id: chatId,
          request_id: requestId,
          sendNonErptoAI: sendNonErptoAI,
        })}`
      }),
      cancel: () => false,
    }
  }

  if (!window.frappe) {
    return {
      promise: Promise.reject(new Error('Frappe API is unavailable in actual mode.')),
      cancel: () => false,
    }
  }

  const controller = new AbortController()
  let settled = false
  let timeoutId = null
  let pollTimer = null
  let finish = () => {}

  const promise = new Promise((resolve, reject) => {
    finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(pollTimer)
      controller.abort()
      fn(value)
    }

    postMethod(API.PIPELINE, {
      user_question: userQuestion,
      chat_id: chatId,
      request_id: requestId,
      sendNonErptoAI: sendNonErptoAI,
    }, controller.signal)
      .then((message) => finish(resolve, message))
      .catch((err) => {
        if (settled) return
        // A server error with a message is final. A dropped or timed-out connection is not:
        // the pipeline keeps running on the server and its result can still be polled.
        if (err?.responseJSON) finish(reject, err)
        else onConnectionLost?.()
      })

    const schedulePoll = () => {
      if (!settled) pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
    }
    const poll = () => {
      if (settled) return
      getMethod(API.PIPELINE_RESULT, { request_id: requestId })
        .then((res) => {
          if (res?.status === 'done') finish(resolve, res.result)
          else if (res?.status === 'error') finish(reject, new Error(res.error || 'Request failed on the server.'))
          else schedulePoll()
        })
        .catch(schedulePoll)
    }
    pollTimer = setTimeout(poll, POLL_START_MS)

    timeoutId = setTimeout(() => {
      const err = new Error('Request timed out')
      err.code = 'CHANGAI_TIMEOUT'
      finish(reject, err)
    }, PIPELINE_TIMEOUT_MS)
  })

  const cancel = () => {
    if (settled) return false
    finish(() => {})
    return true
  }

  return { promise, cancel }
}

export function callSupportBotCancelable(message, mode = 'actual') {
  if (mode === 'test') {
    return {
      promise: Promise.resolve(`[TEST MODE] ${JSON.stringify({ message })}`),
      cancel: () => false,
    }
  }

  if (!window.frappe || !window.frappe.call) {
    return {
      promise: Promise.reject(new Error('Frappe API is unavailable in actual mode.')),
      cancel: () => false,
    }
  }

  let requestHandle = null
  let settled = false

  const promise = new Promise((resolve, reject) => {
    requestHandle = window.frappe.call({
      method: API.SUPPORT,
      args: { message },
      callback(r) {
        settled = true
        resolve(r.message)
      },
      error(err) {
        settled = true
        reject(err)
      },
    })
  })

  const cancel = () => {
    if (settled) return false
    if (!requestHandle || typeof requestHandle.abort !== 'function') return false
    requestHandle.abort()
    settled = true
    return true
  }

  return { promise, cancel }
}

export function callSupportBot(message, mode = 'actual') {
  return frappeCall(API.SUPPORT, { message }, mode)
}

export function getSettingsDetails(mode = 'actual') {
  return frappeCall(API.SETTINGS, {}, mode)
}

export function synthesizeTTS(text, voiceId = 'Zayd', mode = 'actual') {
  return frappeCall(API.TTS, {
    text,
    voice_id: voiceId,
  }, mode)
}

export function isRealtimeConnected() {
  return Boolean(window.frappe?.realtime?.socket?.connected)
}
