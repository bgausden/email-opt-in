/* email-opt-in */

// var unirest = require('unirest');
// import unirest from "unirest"
import fetch, { RequestInit, Headers } from "node-fetch"
import { URLSearchParams, URL } from "url"
import fs from "fs"
import readline from "readline"
import { once } from "events"

const MB_API_VER = 6
const MAX_CLIENT_REQ = 1000
const AUDIENCE_CSV = "file:///D:/Downloads/unsubscribed_segment_export_8893817261.csv"
const CSV_HAS_HEADER = true
const API_TOKEN = "b46102a0d390475aae114962a9a1fbd9"
const SITE_ID = -99
const USERNAME = "siteowner"
const PASSWORD = "apitest1234"
const DEFAULT_EMAIL_COL = 1

interface Client {
    FirstName: string
    LastName: string
    Email: string
}

async function getUserToken() {
    var myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/x-www-form-urlencoded")
    myHeaders.append("API-Key", "b46102a0d390475aae114962a9a1fbd9")
    myHeaders.append("SiteId", "-99")

    var urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    var requestOptions: RequestInit = {
        method: "POST",
        headers: myHeaders,
        body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await fetch(
            `https://api.mindbodyonline.com/public/v${MB_API_VER}/usertoken/issue`,
            requestOptions
        )
        const json = await response.json()
        const token = json.AccessToken
        // const token = (await response.json()).AccessToken
        return token
    } catch (error) {
        console.log("error", error)
    }
}

function getAudience() {
    try {
        const readable = fs.createReadStream(new URL(AUDIENCE_CSV))
        return readable
    } catch (error) {
        console.error(error)
    }
}

async function getClients(accessToken: string, offset: number) {
    let myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", "b46102a0d390475aae114962a9a1fbd9")
    myHeaders.append("SiteId", "-99")
    myHeaders.append("Authorization", accessToken)

    var urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    let init: RequestInit = {
        method: "GET",
        headers: myHeaders,
        // body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await fetch(
            `https://api.mindbodyonline.com/public/v${MB_API_VER}/client/clients?limit=${MAX_CLIENT_REQ}&offset=${offset}&searchText=`,
            init
        )
        const json = await response.json()
        const clients: Client[] = json.Clients
        return new Promise<Client[]>((resolve) => {
            resolve(clients)
        })
    } catch (error) {
        console.log("error", error)
    }
}

async function getEmails() {
    const readableAudience = getAudience()
    const rl = readline.createInterface(readableAudience!)
    let emails: string[] = []
    let firstLine = true
    rl.on("line", (line) => {
        let email = line.split(",", 10)[DEFAULT_EMAIL_COL - 1]
        if (firstLine && CSV_HAS_HEADER) {
            firstLine = false
        } else {
            emails.push(email)
        }
    })
    return new Promise<string[]>((resolve) => {
        rl.on("close", () => {
            resolve(emails)
        })
    })
}

async function main() {
    const emails = await getEmails()
    const accessToken = await getUserToken()
    const clients = await getClients(accessToken, 0)
    if (!!clients) {
        clients.forEach((client) => {
            console.log(client.Email || "")
        })
    }
    console.log("Done.")
}

main()
