/* email-opt-in */

/* Run from PS command-line: $env:DEBUG="*,-getClients"; node .\dist\index.js */

// TODO #1 capture and dump clients where updates failed
// TODO #2 add config to control data sources, data outputs and what logging to generate.
// TODO #3 add progress meter

import fetch, { Headers } from "node-fetch"
import { URLSearchParams } from "url"
import fs from "fs"
import readline from "readline"
import { BackoffError, RequestRateLimiter } from "request-rate-limiter"
import debug from "debug"
import dotenv from "dotenv"
// eslint-disable-next-line no-unused-vars
const env = dotenv.config()

const MB_API_VER = 6
const BASE_URL = `https://api.mindbodyonline.com/public/v${MB_API_VER}`
const MAX_CLIENTS_TO_PROCESS = 10000
const MAX_CLIENT_REQ = 100 // in range 0 - 200
const AUDIENCE_CSV = "./data/unsubscribed_segment_export_71409e2f2f.csv"
// const AUDIENCE_CSV = "./data/opt-out-emails-mbo-test.csv"
const BAD_CLIENTS = "./data/Clients_Failed_Update.log"
const REVIEW_CLIENTS = "./data/Clients_For_Review.log"
// const DEFAULT_LOG = "./data/default.log"
const CSV_HAS_HEADER = true
// Test
//const API_TOKEN = "b46102a0d390475aae114962a9a1fbd9"
//const SITE_ID = "-99"
//const SITEOWNER = "Siteowner"
// Production
const API_TOKEN = process.env.API_TOKEN ? process.env.API_TOKEN : "b46102a0d390475aae114962a9a1fbd9"
const SITE_ID = process.env.SITE_ID ? process.env.SITE_ID : "-99"
const SITEOWNER = process.env.SITEOWNER ? process.env.SITEOWNER : "SiteOwner"
const PASSWORD = process.env.PASSWORD ? process.env.PASSWORD : "apitest1234"
const DEFAULT_EMAIL_COL = 1

interface Client {
    Id: string
    FirstName: string
    LastName?: string
    Email: string
    Action?: string
    Notes?: string
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

interface updateClientsResult {
    optedInClients: number
    optedOutClients: number
    updateFailedClients: number
}

/*
This class is supposed to implement the use of fetch to access data instead
of the request-rate-limiter built-in implemenation that used request (now deprecated)
Can probably be ignored so we don't have to deal with passing options in request-form to
fetch (which expects them in fetch-form)
*/
class fetchRequestHandler {
    // eslint-disable-next-line no-unused-vars
    constructor(public backoffCode: number = 429) { }
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
    myHeaders.append("SiteId", SITE_ID)

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", SITEOWNER)
    urlencoded.append("Password", PASSWORD)

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
        userTokenDebug("Have MB user token %s.", token)
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
    urlencoded.append("Username", SITEOWNER)
    urlencoded.append("Password", PASSWORD)

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
/**
 * @param accessToken Auth token to access MB REST API
 * @param clientID Client ID
 * @param optOut Whether to opt the client out of marketing emails
 */
async function updateClientOptInStatus(
    accessToken: string,
    clientID: string,
    optOut: boolean
): Promise<string> {
    const optInStatusDebug = debug("optInStatus")
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
            SendPromotionalEmails: !optOut,
            // Does nothing - you can't change the settings for texts via the API
            SendPromotionalTexts: !optOut,
            SendScheduleEmails: true,
            SendScheduleTexts: true,
        },
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
                            if (optOut) { optInStatusDebug("Opted out %s.", client.Id) }
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
    /*
    TODO look into more granular opt-out e.g. only opt-out from marketing
    but keep transactional emails
    */
    accessToken: string,
    clients: Client[],
    optOutEmails: Set<string>
): Promise<updateClientsResult> {
    const updateClientsDebug = debug("updateClients")
    const failedUpdateDebug = debug("failedClientUpdate")
    const clientReviewDebug = debug("reviewClients")
    let optedInCount = 0
    let updateFailCount = 0
    let optedOutCount = 0
    for (const client of clients) {
        // optOutEmails is all the user who have opted out via MailChimp
        let optOut = optOutEmails.has(client.Email)
        clientReviewDebug("Opting out client %s %s %s due to presence of email (%s) in MailChimp CSV", client.Id, client.FirstName, client.LastName, client.Email)
        clientsProcessed += 1
        if (clientsProcessed % 100 == 0) {
            globalStatsDebug(
                "%d of %d clients processed",
                clientsProcessed,
                clientsRetrieved
            )
        }
        if (client.Notes?.trim()) {
            const Id: String = client.Id
            // const Notes:String = client.Notes
            const FirstName: String = client.FirstName
            const LastName: String | undefined = client.LastName
            /* There's possibly a note saying don't send emails so play it safe */
            optOut = true
            const warning = `Opting out client ${Id} ${FirstName} ${LastName} due to presence of notes on file.`
            clientReviewDebug("Opting out client %s %s %s due to presence of notes on file.", Id, FirstName, LastName)
            // const info = `${Id} ${FirstName} ${LastName} notes are: ${Notes.substr(0,20)}`
            // clientReviewDebug(info)
            const writeSuccess = review_clients.write(`${warning}\n`)
            if (!writeSuccess) {
                failedUpdateDebug(
                    `Failed to write ${Id} ${FirstName} ${LastName} to file: ${bad_clients.path}. Continuing anyway.`
                )
            }
        }
        try {
            await updateClientOptInStatus(accessToken, client.Id, optOut)
            if (optOut) {
                // mainDebug("O")
                optedOutCount += 1
            } else {
                // mainDebug(".")
                // updateClientsDebug("Opted in %s %s %s", client.Id, client.FirstName, client.LastName)
                optedInCount += 1
            }
        } catch (error) {
            failedUpdateDebug(`Client update failed %o`, error)
            updateFailCount += 1
            const writeSuccess = bad_clients.write(`${JSON.stringify(error)}\n`)
            if (!writeSuccess) {
                failedUpdateDebug(
                    `Failed to write to file: ${bad_clients.path}`
                )
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
    return {
        optedInClients: optedInCount,
        optedOutClients: optedOutCount,
        updateFailedClients: updateFailCount,
    }
}

async function processClients() {
    // eslint-disable-next-line no-unused-vars
    const optOutEmails = await getEmails()
    const accessToken = await getUserToken()
    const updateClientPromises: Promise<updateClientsResult>[] = []
    mainDebug("Retrieving and updating clients.")
    for (
        let index = 0;
        index < MAX_CLIENTS_TO_PROCESS;
        index += MAX_CLIENT_REQ
    ) {
        try {
            const clients = await getClients(accessToken, index)
            if (!!clients && !(clients instanceof Error)) {
                clientsRetrieved += clients.length
                updateClientPromises.push(
                    updateClients(accessToken, clients, optOutEmails)
                )
                mainDebug(`Pushed in-flight batch at index %d`, index)
                if (clients.length == 0) {
                    mainDebug(`All %d clients retrieved.`, clientsRetrieved)
                    break
                }
            }
        } catch (error) {
            mainDebug(error)
        }
    }
    Promise.all(updateClientPromises)
        .then((result) =>
            mainDebug(`%d update client batches processed`, result.length)
        )
        .catch((error) =>
            mainDebug(`update clients batch update failed %O`, error)
        )
        .finally(() =>
            bad_clients.end(() => mainDebug("Closed bad clients file"))
        )
}

const mainDebug = debug("main")
const globalStatsDebug = debug("global-stats")
const bad_clients = fs.createWriteStream(BAD_CLIENTS)
const review_clients = fs.createWriteStream(REVIEW_CLIENTS)
let clientsRetrieved = 0
let clientsProcessed = 0
const limiter = initLimiter()
limiter.setRequestHandler(new fetchRequestHandler())
processClients()
    .catch((error) => mainDebug(error as Error))
    .finally(() => { })
