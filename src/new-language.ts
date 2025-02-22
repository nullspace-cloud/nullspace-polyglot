import * as fs from "fs"
import OpenAI from "openai"
import getLanguage from "./language-map"
import { DEFAULT_CONTEXT } from "./context"

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

/**
 * The options file structure.
 *
 * @field targetLanguage the target language of this operation, and only required parameter
 * @field langDir the directory holding all language files, defaulting to context.langDir
 * @field baseLanguage the ISO639-1 two-letter base language code name (i.e., "en") of the company, defaulting to context.baseLanguage
 * @field validatedLanguages a list of ISO639-1 two-letter code names of all validated languages, defaulting to context.validatedLanguages
 * @field model the OpenAI LLM model to use (i.e., "gpt-4o"), defaulting to context.model
 * @field companyName the name of the company used in the LLM system prompt, defaulting to context.companyName
 * @field companyDescription a brief description of the company to add context to the system prompt, defaulting to context.companyDescription
 * @field modelTemperature the temperature of the LLM model (the lower the temperature, the more deterministic the model), defaults to 0.1 unless specified
 */
interface Options {
    targetLanguage: string
    langDir?: string
    companyName?: string
    model?: string
    companyDescription?: string
    baseLanguage?: string
    validatedLanguages?: string[]
    modelTemperature?: number
    fillerWord?: boolean
}

/**
 * Exception thrown when the retrieved translation keys do not match the submitted ones.
 */
class KeyMismatch extends Error {
    constructor(missingKeys: string[], extraKeys: string[]) {
        super()
        this.message = `Key mismatch detected:
        - Missing keys in translated file: ${JSON.stringify(missingKeys, null, 2)}
        - Extra keys in translated file: ${JSON.stringify(extraKeys, null, 2)}`
    }
}

/**
 * The method iterates through the translations of all validated languages for each term and produces
 * a TranslationRequest object that aggregates their values in a single list.
 *
 * @param options the provided options
 *
 * @return Record<string, string[]> object containing a list of valid translations for each term
 */
const convertValidatedFiles = (options: Options): Record<string, string[]> => {
    const langDir: string = options.langDir || DEFAULT_CONTEXT.langDir
    const baseLang: string = options.baseLanguage || DEFAULT_CONTEXT.baseLanguage
    const validatedLangs: string[] = options.validatedLanguages || DEFAULT_CONTEXT.validatedLanguages
    let allLanguages: string[] = []

    if (!fs.existsSync(`${langDir}${baseLang.toLowerCase()}.json`)) {
        throw new Error("Base language file was not found in the indicated directory")
    }

    if (validatedLangs.length < 2) {
        allLanguages = [baseLang, ...validatedLangs]
    } else {
        allLanguages = [...validatedLangs]
    }

    const translations: Record<string, string[]> = {}

    for (const lang of allLanguages) {
        const filePath = `${langDir}${lang.toLowerCase()}.json`

        if (!fs.existsSync(filePath)) {
            console.error(`Skipped file not found: ${filePath}`)
            continue
        }

        const langData: Record<string, string> = JSON.parse(fs.readFileSync(filePath, "utf-8"))

        // Add translations to the result as an array of strings for each term
        for (const [key, value] of Object.entries(langData)) {
            if (!translations[key]) {
                translations[key] = []
            }
            translations[key].push(value)
        }
    }

    return translations
}

/**
 * This method formats the user prompt as a string for the LLM model, using the desired target language
 * name and the TranslationRequest object containing the validated translations.
 *
 * @param options the provided options
 * @param data the data in the verified languages to be translated
 *
 * @return the user prompt as a string
 *
 * @see convertValidatedFiles
 */
const createUserPrompt = (options: Options, data: Record<string, string[]>): string => {
    const targetLanguageCode = options.targetLanguage
    const targetLanguage = getLanguage(targetLanguageCode)

    return `Target Language: ${targetLanguage}

    ${JSON.stringify(data, null, 2)}`
}

/**
 * The method creates a system prompt for the model to use, detailing the response format
 * and incorporating the company name and descriptions (if any) for a more tailored request.
 *
 * @param options the provided options
 *
 * @return the system prompt as a string
 */
const createSystemPrompt = (options: Options): string => {
    let prompt = "You are a translation assistant"

    if (!options.companyName && !DEFAULT_CONTEXT.companyName) {
        prompt += "."
    } else {
        prompt += ` who works for a company called ${options.companyName || DEFAULT_CONTEXT.companyName}.`
    }

    if (!options.companyDescription && !DEFAULT_CONTEXT.companyDescription) {
        prompt += "\n"
    } else {
        prompt += ` ${options.companyDescription || DEFAULT_CONTEXT.companyDescription}\n\n`
    }

    prompt += `You will receive a list of terms that need to be translated in different languages. Each term will be shown in different places of the company's web application and is formatted as follows:
{
    term: [value1, value2, ...],
    term: [value1, ...],
    ...
}

Your job is to translate each term into the specified target language using the array of validated translated values provided in different languages to understand the context of the term. 
You MUST take into consideration the context where the company operates and the fact that this is a web application for an accurate translation of each term.
Return a new JSON object following the format:
{
    term: value,
    term: value,
    ...
}
The value should present your best translation for the given term in the target language.
If you are unsure about the context of a term or its translation and believe it requires further human validation, you can format the term as follows and set the 'flagged' to true: 
{
    term: {
        value: string,
        flagged: boolean
    }, ...
}
Ensure translations are consistent and take into consideration the context where the term is used and the cultural context of the target language. For instance, if you decide to translate a term as 'sign up', any related meanings need to maintain consistency and you should not switch to synonyms like 'register'.`

    if (options.fillerWord) {
        prompt += `\nYour translations need to take into account that the string '%s' is occasionally used as a placeholder to inject content dynamically, and must be placed appropriately according to the target language sentence structure.`
    }

    prompt += `\nMost languages will use informal speech on websites, though for some languages (especially eastern european and baltic languages) it is appropriate to use formal speech. You must decide what is most appropriate and be consistent with this approach for the target language to feel as natural as possible.
Not all terms may have a proper translation as some languages use English terms for tech terms. For each term, you must consider the best translation for a web application in the target language.
The amount of translated terms must always match the amount of terms given in the request.

A request could look like the example below:
Target Language: Italian`

    if (options.fillerWord) {
        prompt += `
{
    "Clients": ["Clients", "Klanten", "Клиенты"],
    "Body of request": ["Body of request", "Inhoud van verzoek", "Текст сообщения"],
    "Must be at least %s characters long": ["Must be at least %s characters long", "Moet minstens %s karakters lang zijn", "Должен быть длиннее %s символов"]
}

Assuming you are sure about each translation and they do not need to be flagged, your response should look like the following:
{
    "Clients": "Clienti",
    "Body of request": "Messaggio",
    "Must be at least %s characters long": "Deve contenere minimo %s caratteri"
}`
    } else {
        prompt += `
{
    "Clients": ["Clients", "Klanten", "Клиенты"],
    "Body of request": ["Body of request", "Inhoud van verzoek", "Текст сообщения"]
}

Assuming you are sure about each translation and they do not need to be flagged, your response should look like the following:
{
    "Clients": "Clienti",
    "Body of request": "Messaggio"
}`
    }

    return prompt
}

/**
 * Splits the given Record<string, string[]> object into smaller chunks not exceeding the set chunkSize.
 *
 * @param data the full Record<string, string[]> object containing every term in the system
 * @param chunkSize the maximum chunk size in characters, defaults to 40,000 (roughly 10,000 tokens)
 *
 * @return an array of Record<string, string[]> objects corresponding to the original object split in smaller chunks
 */
const chunkRequest = (data: Record<string, string[]>, chunkSize = 40000): Record<string, string[]>[] => {
    const chunks: Record<string, string[]>[] = []
    let currentChunk: Record<string, string[]> = {}
    let currentLength = 0

    for (const [key, values] of Object.entries(data)) {
        let entryLength = key.length + 8 + (values.length - 1) * 4

        // Example calculation:
        // term: ["value"],                         +8
        // term: ["value", "value"],                +12
        // term: ["value", "value", "value"],       +16

        for (const v of values) {
            entryLength += v.length
        }

        if (currentLength + entryLength > chunkSize) {
            chunks.push(currentChunk)
            currentChunk = {}
            currentLength = 0
        }

        currentChunk[key] = values
        currentLength += entryLength
    }

    //Add last chunk
    if (Object.keys(currentChunk).length > 0) {
        chunks.push(currentChunk)
    }

    return chunks
}

/**
 * This function takes a TranslationRequest object as input and uses method createPrompt to forward the
 * request to the model. The TranslationResponse object received is then parsed as JSON and returned.
 *
 * @param options the provided options
 * @param chunk the TranslationRequest chunk to send to the LLM
 *
 * @return the TranslationResponse object containing corresponding translations in the target language
 */
const translateChunk = async (
    options: Options,
    chunk: Record<string, string[]>,
): Promise<Record<string, string | { value: string; flagged: boolean }> | null> => {
    const model = options.model || "gpt-4o"
    const systemPrompt = createSystemPrompt(options)
    const userPrompt = createUserPrompt(options, chunk)

    try {
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: options.modelTemperature || 0.1,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            response_format: {
                type: "json_object",
            },
        })

        const translatedContent = response.choices[0].message.content

        let translatedData: Record<string, string | { value: string; flagged: boolean }> = {}
        if (translatedContent != null) {
            translatedData = JSON.parse(translatedContent)
        }
        return translatedData
    } catch (error) {
        console.error("Error in API call:", error)
        return null
    }
}

/**
 * The function converts the base and validated language files into Record<string, string[]> objects
 * using convertValidatedFiles, and splits them into separate chunks using chunkRequest. Each chunk
 * is forwarded and translated individually to the LLM using translateChunk, and the responses are
 * aggregated and returned in a Record<string, string | { value: string; flagged: boolean }> object.
 *
 * @param options the provided options
 *
 * @return a Record<string, string | { value: string; flagged: boolean }> object containing every term in the system
 *
 * @see convertValidatedFiles
 * @see chunkRequest
 * @see translateChunk
 */
const translate = async (
    options: Options,
): Promise<Record<string, string | { value: string; flagged: boolean }> | null> => {
    const baseLanguages = convertValidatedFiles(options)
    const chunks = chunkRequest(baseLanguages)
    let fullTranslation: Record<string, string | { value: string; flagged: boolean }> = {}

    let i = 0

    for (const chunk of chunks) {
        i = i + 1
        const translatedChunk = await translateChunk(options, chunk)
        if (translatedChunk) {
            fullTranslation = { ...fullTranslation, ...translatedChunk }
        } else {
            console.log(`Chunk [${i}] Translation Failed.`)
            return null
        }
    }

    return fullTranslation
}

/**
 * Simple key validation function to assert that keys in the Record<string, string> object received match the
 * keys in the original TranslationRequest object forwarded.
 *
 * @param translatedData the received Record<string, string> object
 * @param options the provided options
 *
 * @throws KeyMismatch if extra or missing keys are found
 */
const validateKeys = (translatedData: Record<string, string>, options: Options): void => {
    const baseLang = JSON.parse(fs.readFileSync(`${options.langDir}${options.baseLanguage}.json`, "utf-8"))
    const baseKeys = new Set(Object.keys(baseLang))
    const translatedKeys = new Set(Object.keys(translatedData))

    const missingKeys = [...baseKeys].filter(key => !translatedKeys.has(key))
    const extraKeys = [...translatedKeys].filter(key => !baseKeys.has(key))

    if (missingKeys.length > 0 || extraKeys.length > 0) {
        throw new KeyMismatch(missingKeys, extraKeys)
    }
}

/**
 * Extracts the flagged entries from the returned Record<string, string | { value: string; flagged: boolean }> object.
 *
 * @param translatedData the received Record<string, string | { value: string; flagged: boolean }> object
 *
 * @return the Record<string, { value: string; flagged: boolean }> object containing the flagged terms
 */
const flaggedEntries = (
    translatedData: Record<string, string | { value: string; flagged: boolean }>,
): Record<string, string | { value: string; flagged: boolean }> => {
    return Object.entries(translatedData).reduce(
        (acc, [key, entry]) => {
            if (typeof entry !== "string" && entry.flagged) {
                acc[key] = entry
            }
            return acc
        },
        {} as Record<string, { value: string; flagged: boolean }>,
    )
}

/**
 * Given the desired target language, the method runs the translation function, validates the results, and writes to the appropriate file. Use the options
 * in the parameters to override information from the main context.ts file in the working directory. Make sure to provide the target language of this operation.
 *
 * @param options the provided options
 */
const main = (options: Options) => {
    const fullOptions: Options = {
        ...DEFAULT_CONTEXT,
        ...options,
    }

    translate(fullOptions).then(translatedData => {
        if (translatedData) {
            try {
                // Flag data and save it separately with extra metadata
                const flaggedData = flaggedEntries(translatedData)
                const targetFilePath: string = `${fullOptions.langDir}${fullOptions.targetLanguage.toLowerCase()}.json`
                const targetMetaPath: string = `${fullOptions.langDir}${fullOptions.targetLanguage.toLowerCase()}-meta.json`

                // Convert to CompactResponse for the main file
                const compactResponse: Record<string, string> = Object.entries(translatedData).reduce(
                    (acc, [key, entry]) => {
                        if (typeof entry !== "string") {
                            acc[key] = entry.value
                        } else {
                            acc[key] = entry
                        }
                        return acc
                    },
                    {} as Record<string, string>,
                )

                // Validate that both files have matching keys
                validateKeys(compactResponse, fullOptions)

                // Write the JSON translation file
                writeFile(targetFilePath, compactResponse)

                if (Object.keys(flaggedData).length > 0) {
                    // Write the metadata file
                    writeFile(targetMetaPath, flaggedData)
                }
            } catch (e) {
                console.error(e.message)
            }
        } else {
            console.log("Translation failed.")
        }
    })
}

/**
 * Simple utility function to write to a filePath.
 * @param filePath the filepath to write to
 * @param JSONContent the JSONContent to stringify
 */
const writeFile = (filePath: string, JSONContent): void => {
    fs.writeFile(filePath, JSON.stringify(JSONContent, null, 2), error => {
        if (error) {
            console.error(error)
            throw error
        }
    })
}

//Example Usage:
main({
    targetLanguage: "el",
})
