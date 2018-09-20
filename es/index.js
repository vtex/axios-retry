import isRetryAllowed from 'is-retry-allowed'
import axiosLib from 'axios'
import safeStringify from 'fast-safe-stringify'

const CancelToken = axiosLib.CancelToken

const namespace = 'axios-retry'

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isNetworkError(error) {
  const {
    qwestLegacy = false,
  } = error.config || {}

  return !error.response &&
    Boolean(error.code) && // Prevents retrying cancelled requests
    (
      error.code !== 'ECONNABORTED' || !!qwestLegacy
    ) && // Prevents retrying timed out requests
    isRetryAllowed(error) // Prevents retrying unsafe errors
}

const SAFE_HTTP_METHODS = ['get', 'head', 'options']
const IDEMPOTENT_HTTP_METHODS = SAFE_HTTP_METHODS.concat(['put', 'delete'])

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isRetryableError(error) {
  return error.code !== 'ECONNABORTED' &&
    (!error.response || (error.response.status >= 500 && error.response.status <= 599))
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isSafeRequestError(error) {
  if (!error.config) {
    // Cannot determine if the request can be retried
    return false
  }

  return isRetryableError(error) && SAFE_HTTP_METHODS.indexOf(error.config.method) !== -1
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isIdempotentRequestError(error) {
  if (!error.config) {
    // Cannot determine if the request can be retried
    return false
  }

  return isRetryableError(error) && IDEMPOTENT_HTTP_METHODS.indexOf(error.config.method) !== -1
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isNetworkOrIdempotentRequestError(error) {
  return isNetworkError(error) || isIdempotentRequestError(error)
}

/**
 * @return {number} - delay in milliseconds, always 0
 */
function noDelay() {
  return 0
}

/**
 * @param  {number} [retryNumber=0]
 * @return {number} - delay in milliseconds
 */
export function exponentialDelay(retryNumber = 0) {
  const delay = Math.pow(2, retryNumber) * 100
  const randomSum = delay * 0.2 * Math.random() // 0-20% of the delay
  return delay + randomSum
}

/**
 * Initializes and returns the retry state for the given request/config
 * @param  {AxiosRequestConfig} config
 * @return {Object}
 */
function getCurrentState(config) {
  const currentState = config[namespace] || {}
  currentState.retryCount = currentState.retryCount || 0
  currentState.requests = currentState.requests || []
  currentState.cancelled = 'cancelled' in currentState ? currentState.cancelled : false
  currentState.response = 'response' in currentState ? currentState.response : null

  config[namespace] = currentState
  return currentState
}

/**
 * Returns the axios-retry options for the current request
 * @param  {AxiosRequestConfig} config
 * @param  {AxiosRetryConfig} defaultOptions
 * @return {AxiosRetryConfig}
 */
function getRequestOptions(config, defaultOptions) {
  return Object.assign({}, defaultOptions, config[namespace])
}

/**
 * @param  {Axios} axios
 * @param  {AxiosRequestConfig} config
 */
function fixConfig(axios, config) {
  if (axios.defaults.agent === config.agent) {
    delete config.agent
  }
  if (axios.defaults.httpAgent === config.httpAgent) {
    delete config.httpAgent
  }
  if (axios.defaults.httpsAgent === config.httpsAgent) {
    delete config.httpsAgent
  }
}

function createCancelToken() {
  const cancelSource = CancelToken.source()
  return {
    cancelSource,
    cancelToken: cancelSource.token,
  }
}

function cleanupOutput(output) {
  if (!('config' in output)) {
    return output
  }
  const { config } = output
  const safeConfig = JSON.parse(safeStringify(config))
  output.config = safeConfig
  return output
}

/**
 * Adds response interceptors to an axios instance to retry requests failed due to network issues
 *
 * @example
 *
 * import axios from 'axios';
 *
 * axiosRetry(axios, { retries: 3 });
 *
 * axios.get('http://example.com/test') // The first request fails and the second returns 'ok'
 *   .then(result => {
 *     result.data; // 'ok'
 *   });
 *
 * // Exponential back-off retry delay between requests
 * axiosRetry(axios, { retryDelay : axiosRetry.exponentialDelay});
 *
 * // Custom retry delay
 * axiosRetry(axios, { retryDelay : (retryCount) => {
 *   return retryCount * 1000;
 * }});
 *
 * // Also works with custom axios instances
 * const client = axios.create({ baseURL: 'http://example.com' });
 * axiosRetry(client, { retries: 3 });
 *
 * client.get('/test') // The first request fails and the second returns 'ok'
 *   .then(result => {
 *     result.data; // 'ok'
 *   });
 *
 * // Allows request-specific configuration
 * client
 *   .get('/test', {
 *     'axios-retry': {
 *       retries: 0
 *     }
 *   })
 *   .catch(error => { // The first request fails
 *     error !== undefined
 *   });
 *
 * @param {Axios} axios An axios instance (the axios object or one created from axios.create)
 * @param {Object} [defaultOptions]
 * @param {number} [defaultOptions.retries=3] Number of retries
 * @param {Function} [defaultOptions.retryCondition=isNetworkOrIdempotentRequestError]
 *        A function to determine if the error can be retried
 * @param {Function} [defaultOptions.retryDelay=noDelay]
 *        A function to determine the delay between retry requests
 * @return {undefined}
 */
export default function axiosRetry(axios, defaultOptions) {
  const cancelAll = (config) => {
    const currentState = getCurrentState(config)

    currentState.cancelled = true

    const { requests } = currentState

    requests
      .forEach(request => {
        request.preventRetryFromTimeout = true
        request.preventRetryFromError = true
      })

    if (config.cancelSource) {
      config.cancelSource.cancel({ config })
    }
  }

  const retry = (config) => {
    const request = axios({
      ...config,
    })
    request.catch(() => {})

    return request
  }

  axios.interceptors.request.use((config) => {
    const currentState = getCurrentState(config)
    currentState.lastRequestTime = Date.now()

    const { retryTimeout, cancelToken } = config

    let curConfig = { ...config }

    if (!cancelToken) {
      curConfig = {
        ...curConfig,
        ...createCancelToken(),
      }
    }

    const {
      qwestLegacy = false,
    } = getRequestOptions(config, defaultOptions)

    curConfig = {
      ...curConfig,
      qwestLegacy,
      preventRetryFromTimeout: false,
      preventRetryFromError: false,
      hasRetriedFromTimeout: false,
      hasRetriedFromError: false,
      retryFromTimeout: null,
    }

    if (retryTimeout) {
      setTimeout(() => {
        if (!curConfig.preventRetryFromTimeout) {
          curConfig.preventRetryFromError = true
          curConfig.hasRetriedFromTimeout = true

          curConfig.retryFromTimeout = retry({ ...curConfig })
        }
      }, retryTimeout)
    }

    currentState.requests.push(curConfig)

    return curConfig
  })

  // In case of success
  axios.interceptors.response.use(response => {
    const returnValue = Promise.resolve(response)

    const { config } = response
    if (!config) return returnValue

    const currentState = getCurrentState(config)
    if (!currentState) return returnValue

    currentState.response = response

    // cancel all pending requests
    cancelAll(config)

    return returnValue
  }, error => {
    // In case of error

    const isCancellation = error.__CANCEL__
    const config = isCancellation && error.message && error.message.config ? error.message.config : error.config

    // If we have no information to retry the request
    if (!config) {
      return Promise.reject(error)
    }

    const currentState = getCurrentState(config)

    if (currentState && currentState.response) {
      return Promise.resolve(currentState.response)
    }

    const {
      retries = 3,
      retryCondition = isNetworkOrIdempotentRequestError,
      retryDelay = noDelay,
      qwestLegacy = false,
    } = getRequestOptions(config, defaultOptions)

    const retryMeetsCondition = retryCondition(error)
    const shouldRetry =
      retryMeetsCondition &&
      currentState.retryCount < retries &&
      (!config.hasTimedOut || qwestLegacy) &&
      !config.preventRetryFromError

    config.preventRetryFromTimeout = true

    if (shouldRetry) {
      currentState.retryCount++
      const delay = retryDelay(currentState.retryCount, error)

      // Axios fails merging this configuration to the default configuration because it has an issue
      // with circular structures: https://github.com/mzabriskie/axios/issues/370
      fixConfig(axios, config)

      if (!qwestLegacy && config.timeout && currentState.lastRequestTime) {
        const lastRequestDuration = Date.now() - currentState.lastRequestTime
        // Minimum 1ms timeout (passing 0 or less to XHR means no timeout)
        config.timeout = Math.max((config.timeout - lastRequestDuration) - delay, 1)
        if (config.timeout === 1) {
          config.hasTimedOut = true
        }
      }

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          // retries if it should continue with retrying from error
          if (!config.preventRetryFromError) {
            config.hasRetriedFromError = true
            config.preventRetryFromTimeout = true
            return retry(config)
              .then(result => {
                resolve(result)
              })
              .catch(e => {
                reject(cleanupOutput(e))
              })
          } else if (config.hasRetriedFromTimeout) {
            // if in this meantime (i.e. the delay from retrying from error)
            // the retry from timeout has been dispatched, return that
            // instead and avoid retrying
            return config.retryFromTimeout
              .then(result => resolve(result))
              .catch(e => {
                reject(cleanupOutput(e))
              })
          }
        }, delay)
      })
    // if it still can retry, but retry from error has been prevented,
    // and it has retried from timeout
    } else if (retryMeetsCondition && !config.hasTimedOut && config.hasRetriedFromTimeout) {
      return config.retryFromTimeout
    }

    // reject if can't retry anymore
    return Promise.reject(cleanupOutput(error))
  })
}

// Compatibility with CommonJS
axiosRetry.isNetworkError = isNetworkError
axiosRetry.isSafeRequestError = isSafeRequestError
axiosRetry.isIdempotentRequestError = isIdempotentRequestError
axiosRetry.isNetworkOrIdempotentRequestError = isNetworkOrIdempotentRequestError
axiosRetry.exponentialDelay = exponentialDelay
