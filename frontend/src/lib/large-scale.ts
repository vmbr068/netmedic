// Spectrum picks its scale twice: in CSS (page.css vars, overridden in index.css) and in JS via this media query
// (row heights of TableView / ListView, SideNav, Menu…). Answer it like a touch screen so both agree on "large".
const TOUCH = "not ((hover: hover) and (pointer: fine))"
const matchMedia = window.matchMedia.bind(window)
window.matchMedia = (query: string) => matchMedia(query.trim() === TOUCH ? "all" : query)
