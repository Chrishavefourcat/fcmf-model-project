// Keep dropdown layout and keyboard navigation consistent across browsers.
const selectControls = [];
let openSelectControl = null;

class SelectControl {
  constructor(select) {
    this.select = select;
    this.activeIndex = -1;
    this.wrapper = document.createElement("div");
    this.wrapper.className = "select-control";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.id = `${select.id}Button`;
    this.button.className = "select-trigger";
    this.button.setAttribute("role", "combobox");
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.list = document.createElement("div");
    this.list.id = `${select.id}Options`;
    this.list.className = "select-options hidden";
    this.list.setAttribute("role", "listbox");
    this.button.setAttribute("aria-controls", this.list.id);
    const labels = [...select.labels];
    const label = labels.map((item) => item.textContent.trim()).join(" ") || select.getAttribute("aria-label") || "请选择";
    this.button.setAttribute("aria-label", label);
    this.list.setAttribute("aria-label", label);
    labels.forEach((item) => { item.htmlFor = this.button.id; });
    select.before(this.wrapper);
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    this.wrapper.append(select, this.button);
    document.body.append(this.list);
    this.button.onclick = () => this.isOpen ? this.close() : this.open();
    this.button.onkeydown = (event) => this.keydown(event);
    this.button.onblur = () => this.close();
    // Keep keyboard focus on the trigger while choosing an item with the mouse.
    this.list.onmousedown = (event) => event.preventDefault();
    this.list.onclick = (event) => {
      const option = event.target.closest("[data-option-index]");
      if (option) this.choose(Number(option.dataset.optionIndex));
    };
    select.addEventListener("change", () => this.sync());
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "label", "selected"] });
    this.sync();
  }

  get isOpen() { return !this.list.classList.contains("hidden"); }

  sync() {
    this.close();
    this.button.disabled = this.select.disabled;
    this.button.textContent = this.select.selectedOptions[0]?.textContent || "请选择";
    this.button.title = this.select.selectedOptions[0]?.title || "";
  }

  open() {
    if (this.select.disabled || !this.select.options.length) return;
    openSelectControl?.close();
    this.list.replaceChildren(...[...this.select.options].map((option, index) => {
      const item = document.createElement("div");
      item.id = `${this.select.id}Option${index}`;
      item.className = "select-option";
      item.dataset.optionIndex = index;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.select.selectedIndex));
      item.setAttribute("aria-disabled", String(option.disabled));
      item.textContent = option.textContent;
      item.title = option.title || option.textContent;
      return item;
    }));
    const rect = this.button.getBoundingClientRect();
    const below = Math.max(0, window.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const upwards = below < 160 && above > below;
    this.list.style.width = `${rect.width}px`;
    this.list.style.left = `${rect.left}px`;
    this.list.style.maxHeight = `${Math.min(240, upwards ? above : below)}px`;
    this.list.style.top = upwards ? "auto" : `${rect.bottom + 4}px`;
    this.list.style.bottom = upwards ? `${window.innerHeight - rect.top + 4}px` : "auto";
    this.list.classList.remove("hidden");
    this.button.setAttribute("aria-expanded", "true");
    openSelectControl = this;
    this.activate(this.select.selectedIndex);
  }

  close() {
    this.list.classList.add("hidden");
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-activedescendant");
    if (openSelectControl === this) openSelectControl = null;
  }

  activate(index) {
    this.activeIndex = index;
    [...this.list.children].forEach((item, i) => item.classList.toggle("active", i === index));
    const item = this.list.children[index];
    if (item) {
      this.button.setAttribute("aria-activedescendant", item.id);
      // Scroll only the list, without moving the surrounding page.
      if (item.offsetTop < this.list.scrollTop) this.list.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > this.list.scrollTop + this.list.clientHeight) {
        this.list.scrollTop = item.offsetTop + item.offsetHeight - this.list.clientHeight;
      }
    }
  }

  choose(index) {
    const option = this.select.options[index];
    if (!option || option.disabled) return;
    const changed = this.select.selectedIndex !== index;
    this.select.selectedIndex = index;
    this.sync();
    if (changed) this.select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  keydown(event) {
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      this.close();
      if (key === "Escape") event.preventDefault();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) return;
    event.preventDefault();
    if (key === "Enter" || key === " ") {
      if (this.isOpen) this.choose(this.activeIndex);
      else this.open();
      return;
    }
    if (!this.isOpen) this.open();
    const enabled = [...this.select.options].map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(this.activeIndex);
    const next = key === "Home" ? 0 : key === "End" ? enabled.length - 1
      : (current + (key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
    this.activate(enabled[next]);
  }
}

function syncSelectControls() {
  selectControls.forEach((control) => control.sync());
}

function initSelectControls() {
  document.querySelectorAll("select").forEach((select) => selectControls.push(new SelectControl(select)));
  document.addEventListener("pointerdown", (event) => {
    if (openSelectControl && !openSelectControl.wrapper.contains(event.target) && !openSelectControl.list.contains(event.target)) openSelectControl.close();
  });
  window.addEventListener("resize", () => openSelectControl?.close());
  document.addEventListener("scroll", (event) => {
    if (openSelectControl && !openSelectControl.list.contains(event.target)) openSelectControl.close();
  }, true);
}
