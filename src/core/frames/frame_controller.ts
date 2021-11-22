import { FrameElement, FrameElementDelegate, FrameLoadingStyle } from "../../elements/frame_element"
import { FetchMethod, FetchRequest, FetchRequestDelegate, FetchRequestHeaders } from "../../http/fetch_request"
import { FetchResponse } from "../../http/fetch_response"
import { AppearanceObserver, AppearanceObserverDelegate } from "../../observers/appearance_observer"
import { clearBusyState, getAttribute, parseHTMLDocument, markAsBusy } from "../../util"
import { FormSubmission, FormSubmissionDelegate } from "../drive/form_submission"
import { Snapshot } from "../snapshot"
import { ViewDelegate } from "../view"
import { getAction, expandURL, urlsAreEqual, locationIsVisitable } from "../url"
import { FormInterceptor, FormInterceptorDelegate } from "./form_interceptor"
import { FrameView } from "./frame_view"
import { LinkInterceptor, LinkInterceptorDelegate } from "./link_interceptor"
import { FrameRenderer } from "./frame_renderer"
import { session } from "../index"
import { isAction } from "../types"

export class FrameController implements AppearanceObserverDelegate, FetchRequestDelegate, FormInterceptorDelegate, FormSubmissionDelegate, FrameElementDelegate, LinkInterceptorDelegate, ViewDelegate<Snapshot<FrameElement>> {
  readonly element: FrameElement
  readonly view: FrameView
  readonly appearanceObserver: AppearanceObserver
  readonly linkInterceptor: LinkInterceptor
  readonly formInterceptor: FormInterceptor
  currentURL?: string | null
  formSubmission?: FormSubmission
  fetchResponseLoaded = (fetchResponse: FetchResponse) => {}
  private currentFetchRequest: FetchRequest | null = null
  private resolveVisitPromise = () => {}
  private connected = false
  private hasBeenLoaded = false
  private settingSourceURL = false

  constructor(element: FrameElement) {
    this.element = element
    this.view = new FrameView(this, this.element)
    this.appearanceObserver = new AppearanceObserver(this, this.element)
    this.linkInterceptor = new LinkInterceptor(this, this.element)
    this.formInterceptor = new FormInterceptor(this, this.element)
  }

  connect() {
    if (!this.connected) {
      this.connected = true
      this.reloadable = false
      if (this.loadingStyle == FrameLoadingStyle.lazy) {
        this.appearanceObserver.start()
      }
      this.linkInterceptor.start()
      this.formInterceptor.start()
      this.sourceURLChanged()
    }
  }

  disconnect() {
    if (this.connected) {
      this.connected = false
      this.appearanceObserver.stop()
      this.linkInterceptor.stop()
      this.formInterceptor.stop()
    }
  }

  disabledChanged() {
    if (this.loadingStyle == FrameLoadingStyle.eager) {
      this.loadSourceURL()
    }
  }

  sourceURLChanged() {
    if (this.loadingStyle == FrameLoadingStyle.eager || this.hasBeenLoaded) {
      this.loadSourceURL()
    }
  }

  loadingStyleChanged() {
    if (this.loadingStyle == FrameLoadingStyle.lazy) {
      this.appearanceObserver.start()
    } else {
      this.appearanceObserver.stop()
      this.loadSourceURL()
    }
  }

  async loadSourceURL() {
    if (!this.settingSourceURL && this.enabled && this.isActive && (this.reloadable || this.sourceURL != this.currentURL)) {
      const previousURL = this.currentURL
      this.currentURL = this.sourceURL
      if (this.sourceURL) {
        try {
          this.element.loaded = this.visit(expandURL(this.sourceURL))
          this.appearanceObserver.stop()
          await this.element.loaded
          this.hasBeenLoaded = true
        } catch (error) {
          this.currentURL = previousURL
          throw error
        }
      }
    }
  }

  async loadResponse(fetchResponse: FetchResponse) {
    if (fetchResponse.redirected || (fetchResponse.succeeded && fetchResponse.isHTML)) {
      this.sourceURL = fetchResponse.response.url
    }

    try {
      const html = await fetchResponse.responseHTML
      if (html) {
        const { body } = parseHTMLDocument(html)
        const snapshot = new Snapshot(await this.extractForeignFrameElement(body))
        const renderer = new FrameRenderer(this.view.snapshot, snapshot, false, false)
        if (this.view.renderPromise) await this.view.renderPromise
        await this.view.render(renderer)
        session.frameRendered(fetchResponse, this.element)
        session.frameLoaded(this.element)
        this.fetchResponseLoaded(fetchResponse)
      }
    } catch (error) {
      console.error(error)
      this.view.invalidate()
    } finally {
      this.fetchResponseLoaded = () => {}
    }
  }

  // Appearance observer delegate

  elementAppearedInViewport(element: Element) {
    this.loadSourceURL()
  }

  // Link interceptor delegate

  shouldInterceptLinkClick(element: Element, url: string) {
    if (element.hasAttribute("data-turbo-method")) {
      return false
    } else {
      return this.shouldInterceptNavigation(element)
    }
  }

  linkClickIntercepted(element: Element, url: string) {
    this.reloadable = true
    this.navigateFrame(element, url)
  }

  // Form interceptor delegate

  shouldInterceptFormSubmission(element: HTMLFormElement, submitter?: HTMLElement) {
    return this.shouldInterceptNavigation(element, submitter)
  }

  formSubmissionIntercepted(element: HTMLFormElement, submitter?: HTMLElement) {
    if (this.formSubmission) {
      this.formSubmission.stop()
    }

    this.reloadable = false
    this.formSubmission = new FormSubmission(this, element, submitter)
    const { fetchRequest } = this.formSubmission
    this.prepareHeadersForRequest(fetchRequest.headers, fetchRequest)
    this.formSubmission.start()
  }

  // Fetch request delegate

  prepareHeadersForRequest(headers: FetchRequestHeaders, request: FetchRequest) {
    headers["Turbo-Frame"] = this.id
  }

  requestStarted(request: FetchRequest) {
    markAsBusy(this.element)
  }

  requestPreventedHandlingResponse(request: FetchRequest, response: FetchResponse) {
    this.resolveVisitPromise()
  }

  async requestSucceededWithResponse(request: FetchRequest, response: FetchResponse) {
    await this.loadResponse(response)
    this.resolveVisitPromise()
  }

  requestFailedWithResponse(request: FetchRequest, response: FetchResponse) {
    console.error(response)
    this.resolveVisitPromise()
  }

  requestErrored(request: FetchRequest, error: Error) {
    console.error(error)
    this.resolveVisitPromise()
  }

  requestFinished(request: FetchRequest) {
    clearBusyState(this.element)
  }

  // Form submission delegate

  formSubmissionStarted({ formElement }: FormSubmission) {
    markAsBusy(formElement, this.findFrameElement(formElement))
  }

  formSubmissionSucceededWithResponse(formSubmission: FormSubmission, response: FetchResponse) {
    const frame = this.findFrameElement(formSubmission.formElement, formSubmission.submitter)

    this.proposeVisitIfNavigatedWithAction(frame, formSubmission.formElement, formSubmission.submitter)

    frame.delegate.loadResponse(response)
  }

  formSubmissionFailedWithResponse(formSubmission: FormSubmission, fetchResponse: FetchResponse) {
    this.element.delegate.loadResponse(fetchResponse)
  }

  formSubmissionErrored(formSubmission: FormSubmission, error: Error) {
    console.error(error)
  }

  formSubmissionFinished({ formElement }: FormSubmission) {
    clearBusyState(formElement, this.findFrameElement(formElement))
  }

  // View delegate

  allowsImmediateRender(snapshot: Snapshot, resume: (value: any) => void) {
    return true
  }

  viewRenderedSnapshot(snapshot: Snapshot, isPreview: boolean) {
  }

  viewInvalidated() {
  }

  // Private

  private async visit(url: URL) {
    const request = new FetchRequest(this, FetchMethod.get, url, url.searchParams, this.element)

    this.currentFetchRequest?.cancel()
    this.currentFetchRequest = request

    return new Promise<void>(resolve => {
      this.resolveVisitPromise = () => {
        this.resolveVisitPromise = () => {}
        this.currentFetchRequest = null
        resolve()
      }
      request.perform()
    })
  }

  private navigateFrame(element: Element, url: string, submitter?: HTMLElement) {
    const frame = this.findFrameElement(element, submitter)

    this.proposeVisitIfNavigatedWithAction(frame, element, submitter)

    frame.setAttribute("reloadable", "")
    frame.src = url
  }

  private proposeVisitIfNavigatedWithAction(frame: FrameElement, element: Element, submitter?: HTMLElement) {
    const action = getAttribute("data-turbo-action", submitter, element, frame)

    if (isAction(action)) {
      const { visitCachedSnapshot } = new SnapshotSubstitution(frame)
      frame.delegate.fetchResponseLoaded = (fetchResponse: FetchResponse) => {
        if (frame.src) {
          const { statusCode, redirected } = fetchResponse
          const responseHTML = frame.ownerDocument.documentElement.outerHTML
          const response = { statusCode, redirected, responseHTML }

          session.visit(frame.src, { action, response, visitCachedSnapshot, willRender: false })
        }
      }
    }
  }

  private findFrameElement(element: Element, submitter?: HTMLElement) {
    const id = getAttribute("data-turbo-frame", submitter, element) || this.element.getAttribute("target")
    return getFrameElementById(id) ?? this.element
  }

  async extractForeignFrameElement(container: ParentNode): Promise<FrameElement> {
    let element
    const id = CSS.escape(this.id)

    try {
      if (element = activateElement(container.querySelector(`turbo-frame#${id}`), this.currentURL)) {
        return element
      }

      if (element = activateElement(container.querySelector(`turbo-frame[src][recurse~=${id}]`), this.currentURL)) {
        await element.loaded
        return await this.extractForeignFrameElement(element)
      }

      console.error(`Response has no matching <turbo-frame id="${id}"> element`)
    } catch (error) {
      console.error(error)
    }

    return new FrameElement()
  }

  private formActionIsVisitable(form: HTMLFormElement, submitter?: HTMLElement) {
    const action = getAction(form, submitter)

    return locationIsVisitable(expandURL(action), this.rootLocation)
  }

  private shouldInterceptNavigation(element: Element, submitter?: HTMLElement) {
    const id = getAttribute("data-turbo-frame", submitter, element) || this.element.getAttribute("target")

    if (element instanceof HTMLFormElement && !this.formActionIsVisitable(element, submitter)) {
      return false
    }

    if (!this.enabled || id == "_top") {
      return false
    }

    if (id) {
      const frameElement = getFrameElementById(id)
      if (frameElement) {
        return !frameElement.disabled
      }
    }

    if (!session.elementDriveEnabled(element)) {
      return false
    }

    if (submitter && !session.elementDriveEnabled(submitter)) {
      return false
    }

    return true
  }

  // Computed properties

  get id() {
    return this.element.id
  }

  get enabled() {
    return !this.element.disabled
  }

  get sourceURL() {
    if (this.element.src) {
      return this.element.src
    }
  }

  get reloadable() {
    const frame = this.findFrameElement(this.element)
    return frame.hasAttribute("reloadable")
  }

  set reloadable(value: boolean) {
    const frame = this.findFrameElement(this.element)
    if (value) {
      frame.setAttribute("reloadable", "")
    } else {
      frame.removeAttribute("reloadable")
    }
  }

  set sourceURL(sourceURL: string | undefined) {
    this.settingSourceURL = true
    this.element.src = sourceURL ?? null
    this.currentURL = this.element.src
    this.settingSourceURL = false
  }

  get loadingStyle() {
    return this.element.loading
  }

  get isLoading() {
    return this.formSubmission !== undefined || this.resolveVisitPromise() !== undefined
  }

  get isActive() {
    return this.element.isActive && this.connected
  }

  get rootLocation() {
    const meta = this.element.ownerDocument.querySelector<HTMLMetaElement>(`meta[name="turbo-root"]`)
    const root = meta?.content ?? "/"
    return expandURL(root)
  }
}

class SnapshotSubstitution {
  private readonly clone: Node
  private readonly id: string

  constructor(element: FrameElement) {
    this.clone = element.cloneNode(true)
    this.id = element.id
  }

  visitCachedSnapshot = ({ element }: Snapshot) => {
    const { id, clone } = this

    element.querySelector("#" + id)?.replaceWith(clone)
  }
}

function getFrameElementById(id: string | null) {
  if (id != null) {
    const element = document.getElementById(id)
    if (element instanceof FrameElement) {
      return element
    }
  }
}

function activateElement(element: Element | null, currentURL?: string | null) {
  if (element) {
    const src = element.getAttribute("src")
    if (src != null && currentURL != null && urlsAreEqual(src, currentURL)) {
      throw new Error(`Matching <turbo-frame id="${element.id}"> element has a source URL which references itself`)
    }
    if (element.ownerDocument !== document) {
      element = document.importNode(element, true)
    }

    if (element instanceof FrameElement) {
      element.connectedCallback()
      element.disconnectedCallback()
      return element
    }
  }
}
