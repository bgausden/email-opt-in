const getHeroAsync = async function (email: string) {
    try {
        const response = await axios.get(`${apiUrl}/heroes?email=${email}`)
        const data = parseList(response)
        const hero = data[0]
        return hero
    } catch (error) {
        handleAxiosErrors(error, "Hero")
    }
}

const getOrdersAsync = async function (heroId: number) {
    try {
        const response = await axios.get(`${apiUrl}/orders/${heroId}`)
        const data = parseList(response)
        return data
    } catch (error) {
        handleAxiosErrors(error, "Orders")
    }
}

const getAccountRepAsync = async function (heroId: number) {
    try {
        const response = await axios.get(`${apiUrl}/accountreps/${heroId}`)
        const data = parseList(response)
        return data[0]
    } catch (error) {
        handleAxiosErrors(error, "Account Rep")
    }
}

const getHeroTreeAsync = async function (email: string) {
    const hero = await getHeroAsync(email)
    if (!hero) return

    const [orders, accountRep] = await Promise.all([getOrdersAsync(hero.id), getAccountRepAsync(hero.id)])
    hero.orders = orders
    hero.accountRep = accountRep
    return hero
}
