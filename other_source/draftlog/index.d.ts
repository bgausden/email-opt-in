declare module "draftlog" {

    class draftLogConsole extends Console {
        draft(): any
    }

    class LineCountStream {
        constructor(outStream: any)
        line(): number
        logs(): number
        write(data: any): void
        addLineListener(inStream: any): void
        countLines(data: any): void
        stopLineCount(): void
        resumeLineCount(): void
        rows(): any
        columns(): any
    }
    function into(console: Console, extra?: boolean): LineCountStream
}
