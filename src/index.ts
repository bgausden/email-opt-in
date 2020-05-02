/* email-opt-in */

/* Run from PS command-line: $env:DEBUG="*,-getClients"; node .\dist\index.js */

// TODO #1 capture and dump clients where updates failed
// TODO #2 add config to control data sources, data outputs and what logging to generate.
// TODO #3 add progress meter

import fetch from "node-fetch"
import { Headers } from "node-fetch"
import { URLSearchParams } from "url"
import fs from "fs"
import readline from "readline"
// import draftlog = require("draftlog")
import { BackoffError, RequestRateLimiter } from "request-rate-limiter"
import debug from "debug"

const MB_API_VER = 6
const BASE_URL = `https://api.mindbodyonline.com/public/v${MB_API_VER}`
const MAX_CLIENTS_TO_PROCESS = 1000
const MAX_CLIENT_REQ = 100 // in range 0 - 200
// const AUDIENCE_CSV = "./data/unsubscribed_segment_export_8893817261.csv"
const AUDIENCE_CSV = "./data/opt-out-emails-mbo-test.csv"
const BAD_CLIENTS = "./data/Clients_Failed_Update.log"
// const DEFAULT_LOG = "./data/default.log"
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
            mainDebug(`\nWorker backing off for 10s`)
            throw new BackoffError(`${response.statusText}`)
        } else return response
    }
}

/* class outputFile {
    path: fs.PathLike = DEFAULT_LOG
    writeable: fs.WriteStream | undefined = undefined
    initialized: boolean = false
    constructor(path: fs.PathLike) {
        if (!this.initialized || this.initialized === undefined) {
            try {
                this.writeable = fs.createWriteStream(path || this.path)
                this.writeable.once("open", (fd) => {
                    console.log(`fd:${fd} is open.`)
                })
                this.initialized = true
            } catch (error) {
                throw new Error(error)
            }
        }
    }
    write(data: string): boolean | undefined {
        if (this.initialized) {
            try {
                if (this.writeable!.writable) {
                    return this.writeable?.write(data)
                } else {
                    throw new Error()
                }
            } catch (error) {
                mainDebug(
                    `Not possible to write to ${
                        this.writeable?.path
                    }. ${error.toString()}`
                )
            }
        }
    }

    end() {
        if (this.initialized) {
            this.writeable?.end(() => {
                console.log(`Closed output file.`)
            })
            this.initialized = false
        }
    }
} */

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
    mainDebug(
        `Rate limiting to ${requestRate} API calls per ${interval} seconds. %s`
    )
    return new RequestRateLimiter({
        backoffTime: backoffTime,
        requestRate: requestRate,
        interval: interval,
        timeout: timeout,
    })
}

async function getUserToken() {
    const userTokenDebug = debug("userToken")
    userTokenDebug("Retrieving MB user token")
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
        userTokenDebug("Have MB user token.")
        return token
    } catch (error) {
        userTokenDebug("Failed to retrieve MB user token %o", error)
    }
}

function getAudience() {
    mainDebug("Opening opted-out clients CSV %s", "getAudience")
    try {
        const readable = fs.createReadStream(AUDIENCE_CSV)
        mainDebug("Opening opted-out clients CSV completed. %s", "getAudience")
        return readable
    } catch (error) {
        mainDebug("Opening opted-out clients CSV failed %o", error)
    }
}

async function getClients(accessToken: string, offset: number) {
    const getClientsDebug = debug("getClients")
    getClientsDebug(
        `Retrieving ${MAX_CLIENT_REQ} MB clients from offset ${offset}`
    )
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const urlencoded = new URLSearchParams()
    // TODO #4 replace magic strings
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    const init: any = {
        method: "GET",
        headers: myHeaders,
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
        getClientsDebug(
            `Retrieved ${clients.length} clients from offset ${offset} %s`
        )
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
                            reject(result.Error)
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
    const updateClientsDebug = debug("updateClients")
    const failedUpdateDebug = debug("failedClientUpdate")
    let optedInCount = 0
    let updateFailCount = 0
    let optedOutCount = 0
    for (const client of clients) {
        const optOut = optOutEmails.has(client.Email)
        clientsProcessed += 1
        if (clientsProcessed % 100 == 0) {
            globalStatsDebug(
                "%d of %d clients processed",
                clientsProcessed,
                clientsRetrieved
            )
        }
        try {
            // eslint-disable-next-line no-unused-vars
            const updateResult = await updateClientOptInStatus(
                accessToken,
                client.Id,
                optOut
            )
            // console.logconsole.log(updateResult)
            if (optOut) {
                // mainDebug("O")
                optedOutCount += 1
            } else {
                // mainDebug(".")
                optedInCount += 1
            }
        } catch (error) {
            failedUpdateDebug(`Client update failed %o`, error)
            updateFailCount += 1
            // dump rejected client to file
            const writeSuccess = bad_clients.write(`${JSON.stringify(error)}\n`)
            if (!writeSuccess) {
                failedUpdateDebug(`Failed to write to file`)
            }
        }
    }
    updateClientsDebug(
        `Opted-in: %d, Opted-out: %d, Failed to update: %d`,
        optedInCount,
        optedOutCount,
        updateFailCount
    )
    // updateClientsDebug(`Opted-out: %d`, optedOutCount)
    // updateClientsDebug(`Failed to update: %d`, updateFailCount)
    return [optedInCount, optedOutCount, updateFailCount]
}

async function processClients() {
    // eslint-disable-next-line no-unused-vars
    const optOutEmails = await getEmails()
    const accessToken = await getUserToken()
    mainDebug("Retrieving and updating clients.")
    for (
        let index = 0;
        index <= MAX_CLIENTS_TO_PROCESS;
        index += MAX_CLIENT_REQ
    ) {
        try {
            const clients = await getClients(accessToken, index)
            if (!!clients && !(clients instanceof Error)) {
                clientsRetrieved += clients.length
                if (clients.length == 0) {
                    mainDebug(`All %d clients retrieved.`, clientsRetrieved)
                    break
                }
                // TODO should optInAllClients return a value? What value? Tuple containing Error and Status?
                // TODO use Promise.all to drive all the client updates and then clean up when the Promise.all completes.
                await updateClients(accessToken, clients, optOutEmails)
                    // eslint-disable-next-line no-unused-vars
                    .then((successCount) => {})
                    .catch((error) => {
                        console.log(error)
                        throw error
                    })
            }
        } catch (error) {
            mainDebug(error)
        }
    }
}

const mainDebug = debug("main")
const globalStatsDebug = debug("global-stats")
// const bad_clients = new outputFile(BAD_CLIENTS)
const bad_clients = fs.createWriteStream(BAD_CLIENTS)
let clientsRetrieved = 0
let clientsProcessed = 0
const limiter = initLimiter()
limiter.setRequestHandler(new fetchRequestHandler())
processClients()
    .catch((error) => mainDebug(error as Error))
    .finally(() => {
        bad_clients.end(() => console.log("Closed bad clients file"))
    })
