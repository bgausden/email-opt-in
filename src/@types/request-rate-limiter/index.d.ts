/* eslint-disable no-unused-vars */
declare module "request-rate-limiter" {
    class RequestRateLimiter {
        constructor({
            backoffTime,
            requestRate,
            interval,
            timeout,
        }?: {
            backoffTime?: number
            requestRate?: number
            interval?: number
            timeout?: number
        })
        backoffTime: number
        requestRate: number
        interval: number
        timeout: number
        idle(): Promise<any>
        request(requestConfig: any): Promise<any>
        executeRequest(requestConfig: any): Promise<any>
        setRequestHandler(requestHandler: any): void
    }

    class RequestRequestHandler {
        constructor({ backoffHTTPCode }?: { backoffHTTPCode?: number })
        backoffHTTPCode: number
    }

    class BackoffError extends Error {}
}
