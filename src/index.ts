/* email-opt-in */

import fetch from "node-fetch"
import { Headers } from "node-fetch"
import { URLSearchParams } from "url"
import fs from "fs"
import readline from "readline"
// import draftlog = require("draftlog")
//import request from "request"
import { BackoffError, RequestRateLimiter } from "request-rate-limiter"

const MB_API_VER = 6
const BASE_URL = `https://api.mindbodyonline.com/public/v${MB_API_VER}`
const MAX_CLIENTS_TO_PROCESS = 5000
const MAX_CLIENT_REQ = 100 // in range 0 - 200
// const AUDIENCE_CSV = "./data/unsubscribed_segment_export_8893817261.csv"
const AUDIENCE_CSV = "./data/opt-out-emails-mbo-test.csv"
const CSV_HAS_HEADER = true
const API_TOKEN = "b46102a0d390475aae114962a9a1fbd9"
const SITE_ID = "-99"
const DEFAULT_EMAIL_COL = 1

interface Client {
    Id: string
    FirstName: string
    LastName?: string
    Email: string
    Action?: string
}

interface MBError {
    Message: string
    Code: string
}

interface WrappedClient {
    Client: Client
}

interface WrappedMBError {
    Error: MBError
}

type updateClientResult = WrappedClient | WrappedMBError

interface RequestConfig {
    url: RequestInfo
    init: RequestInit
}

class fetchRequestHandler {
    // eslint-disable-next-line no-unused-vars
    constructor(public backoffCode: number = 429) {}
    async request(requestConfig: any) {
        const url = requestConfig.url
        const init = requestConfig.init
        const response = await fetch(url, init)
        if (response.status === this.backoffCode) {
            console.log(`\nWorker backing off for 10s`)
            throw new BackoffError(`${response.statusText}`)
        } else return response
    }
}

// TODO get draftlog working in Typescript
// Calculate the progress for a progress bar

/**
 * Simple Utility Methods for checking information about a value.
 *
 * @param  {Mixed}  value  Could be anything.
 * @return {Object}
 */
// eslint-disable-next-line no-unused-vars
function is(value: any) {
    return {
        a: function (check: any) {
            if (check.prototype) check = check.prototype.constructor.name
            const type: string = Object.prototype.toString
                .call(value)
                .slice(8, -1)
                .toLowerCase()
            return value != null && type === check.toLowerCase()
        },
    }
}

function initLimiter(
    backoffTime = 10,
    requestRate = 1000,
    interval = 60,
    timeout = 600
) {
    process.stdout.write(
        `Rate limiting to ${requestRate} API calls per ${interval} seconds.\n`
    )
    return new RequestRateLimiter({
        backoffTime: backoffTime,
        requestRate: requestRate,
        interval: interval,
        timeout: timeout,
    })
}

async function getUserToken() {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/x-www-form-urlencoded")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", "-99")

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    const requestOptions: any = {
        method: "POST",
        headers: myHeaders,
        body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await limiter.request({
            url: `${BASE_URL}/usertoken/issue`,
            init: requestOptions,
        } as RequestConfig)
        const json = await response.json()
        const token = json.AccessToken
        return token
    } catch (error) {
        console.log("error", error)
    }
}

function getAudience() {
    try {
        const readable = fs.createReadStream(AUDIENCE_CSV)
        return readable
    } catch (error) {
        console.log(error)
    }
}

async function getClients(accessToken: string, offset: number) {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    const init: any = {
        method: "GET",
        headers: myHeaders,
        // body: urlencoded,
        redirect: "follow",
    }

    const response = await limiter.request({
        url: `${BASE_URL}/client/clients?limit=${MAX_CLIENT_REQ}&offset=${offset}&searchText=`,
        init: init,
    } as RequestConfig)
    const json = await response.json()
    if (Object.prototype.hasOwnProperty.call(json, "Error")) throw json
    const clients: Client[] = json.Clients
    return new Promise<Client[]>((resolve) => {
        resolve(clients)
    })
}

async function getEmails() {
    const readableAudience = getAudience()
    const rl = readline.createInterface(readableAudience!)
    const emails = new Set<string>()
    let firstLine = true
    rl.on("line", (line) => {
        const email = line.split(",", 10)[DEFAULT_EMAIL_COL - 1]
        if (firstLine && CSV_HAS_HEADER) {
            firstLine = false
        } else {
            emails.add(email)
        }
    })
    return new Promise<Set<string>>((resolve) => {
        rl.on("close", () => {
            resolve(emails)
        })
    })
}

async function updateClientOptInStatus(
    accessToken: string,
    clientID: string,
    optOut: boolean
) {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const raw = JSON.stringify({
        Client: {
            Id: clientID,
            SendAccountEmails: true,
            SendAccountTexts: true,
            SendPromotionalEmails: optOut,
            SendPromotionalTexts: optOut,
            SendScheduleEmails: true,
            SendScheduleTexts: true,
        },
        SendEmail: true,
        CrossRegionalUpdate: false,
        Test: false,
    })

    const init: any = {
        method: "POST",
        headers: myHeaders,
        body: raw,
        redirect: "follow",
    }

    return new Promise<string>((resolve, reject) => {
        try {
            limiter
                .request({
                    url: `${BASE_URL}/client/updateclient`,
                    init: init,
                } as RequestConfig)
                .then((response) => {
                    response.json().then((result: any) => {
                        if (isWrappedMBError(result)) {
                            // We assume result is an object containing a single Error property
                            const error = result.Error
                            reject(
                                `Client update failed: Error is ${error.Code}. Error message is ${error.Message}`
                            )
                            return
                        }

                        if (isWrappedClient(result)) {
                            const client = result.Client
                            // following is obsolete?
                            if (client === undefined) {
                                throw new Error(`updatedClient is undefined.`)
                            }
                            if (client.Action !== "Updated") {
                                reject(
                                    `Client ${client.Id} ${client.FirstName} ${client.LastName} failed to update.`
                                )
                            }
                            resolve(`${client.Id}: ${client.Action}`)
                        }

                        // should never reach here
                        reject(`Invalid result from fetch: ${result}`)
                    })
                })
        } catch (error) {
            reject(error)
        }
    })
} // end function optInClient()

// type guard using assertion
function isWrappedMBError(result: any): result is WrappedMBError {
    return (result as WrappedMBError).Error !== undefined
}

function isWrappedClient(result: any): result is WrappedClient {
    return (result as WrappedClient).Client !== undefined
}

async function updateClients(
    accessToken: string,
    clients: Client[],
    optOutEmails: Set<string>
) {
    let updateSuccessCount = 0
    for (const client of clients) {
        const optOut = optOutEmails.has(client.Email)
        try {
            await updateClientOptInStatus(accessToken, client.Id, optOut)
            if (optOut) {
                process.stdout.write("O")
            } else {
                process.stdout.write(".")
            }
            updateSuccessCount += 1
            globalUpdateCount += 1
            if (globalUpdateCount % 80 == 0) {
                process.stdout.write(`\n`)
            }
            if (globalUpdateCount % 1000 == 0) {
                console.log(
                    `\n${globalUpdateCount} clients processed. Continuing.`
                )
            }
        } catch (error) {
            // console.log(`\n${error}`)
            process.stdout.write("E")
            globalUpdateCount += 1
            if (globalUpdateCount % 80 == 0) {
                process.stdout.write(`\n`)
            }
        }
    }
    return updateSuccessCount
}

function optOutClients() {}

async function main() {
    // eslint-disable-next-line no-unused-vars
    const optOutEmails = await getEmails()
    const accessToken = await getUserToken()
    for (
        let index = 0;
        index <= MAX_CLIENTS_TO_PROCESS;
        index += MAX_CLIENT_REQ
    ) {
        try {
            const clients = await getClients(accessToken, index)
            if (!!clients && !(clients instanceof Error)) {
                //console.debug(`\n${clients.length} clients retrieved.`)
                if (clients.length === 0) {
                    console.log(`\nAll clients retrieved.`)
                    break
                }
                // process.stdout.write("C")
                // TODO should optInAllClients return a value? What value? Tuple containing Error and Status?
                updateClients(accessToken, clients, optOutEmails)
                    // eslint-disable-next-line no-unused-vars
                    .then((successCount) => {
                        /*                         console.log(
                            `\nIndex:${index}: ${successCount} clients opted-in.`
                        ) */
                    })
                    .catch((error) => {
                        throw error
                    })
            }
        } catch (error) {
            console.log(error)
        }
    }
    optOutClients()
}

// eslint-disable-next-line no-var
var globalUpdateCount = 0
// eslint-disable-next-line no-var
var limiter = initLimiter()
limiter.setRequestHandler(new fetchRequestHandler())

main().catch((error) => console.log(error as Error))
